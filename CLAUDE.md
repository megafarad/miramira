# miramira — Authorization Service

## What this is

A standalone, relationship-based authorization service. It is **not** embedded middleware — all authorization state lives here. External services call miramira's REST API to check permissions, manage tenants, assign roles, and issue/validate API keys.

## Tech stack

| Layer                  | Choice                                               |
|------------------------|------------------------------------------------------|
| Runtime                | Node.js >= 20, ESM (`"type": "module"`)              |
| Framework              | Fastify 5                                            |
| Language               | TypeScript (strict mode, `Node16` module resolution) |
| Database               | PostgreSQL 16 via Drizzle ORM (`postgres` driver)    |
| Authorization engine   | OpenFGA (relationship-based access control)          |
| User authentication    | Supabase JWKS (JWT verification via `jose`)          |
| API key authentication | Custom, managed in PostgreSQL                        |
| Validation             | Zod (env vars, request bodies)                       |

## Folder structure (enforce strictly)

```
src/
└── routes/        # HTTP layer only — input parsing, response shaping
└── services/      # Business logic — orchestrates repositories + OpenFGA
└── repositories/  # Data access only — all Drizzle queries live here
└── openfga/       # OpenFGA client wrapper and tuple mappers
└── workers/       # Outbox processor and other background jobs
└── db/            # Drizzle schema, migrations, client setup
└── plugins/       # Auth, error handling, request context
test/              # Unit tests
```

## Anti-patterns — never do these

- NEVER access the database directly from a route handler
- NEVER call OpenFGA inside a database transaction
- NEVER import drizzle `db` directly into a service — inject it or use a repository
- NEVER swallow errors from OpenFGA writes — failed outbox delivery must be
  logged and retried

## Domain model

### Hierarchical multi-tenancy

Tenants form a tree. Each tenant may have a `parent_id` pointing to another tenant. Roles and scopes assigned at a parent tenant propagate to all descendants. When checking authorization, the full ancestor chain must be considered.

### Principals

Both **users** (authenticated via Supabase JWT) and **API keys** (authenticated via hashed key lookup in PostgreSQL) are principals. A principal can hold one or more roles at one or more tenants.

### Roles and scopes

Roles are named bundles of scopes (permissions). They are defined per-tenant but inherited downward through the hierarchy. A root "master" tenant defines the base set of roles and scopes that all tenants inherit. Child tenants may define additional roles and scopes for themselves, but the master set is always available. When resolving roles/scopes for a tenant, the full ancestor chain is walked — the tenant's own definitions plus all ancestors' up to the master root. The OpenFGA model encodes the role-to-scope expansion and tenant hierarchy relationships.

### Inheritance

Roles are inherited if the tenant is marked as "inherit = true". Additionally, roles override a tenant's "inherit = false" if the role is marked as "crossesBoundary = true"
