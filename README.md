# miramira

> Standalone, relationship-based authorization service. Hierarchical
> multi-tenancy, roles, scopes, audit logging, OpenAPI 3.1 contract —
> backed by PostgreSQL and OpenFGA.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

miramira is **not** embedded middleware. It runs as its own service. Your
applications call its REST API to check permissions, manage tenants, assign
roles, and issue or validate API keys. All authorization state lives here.

## What you get

- **Hierarchical tenants** — tenants form a tree; roles and scopes propagate
  to descendants. Cross-boundary roles override the `inherit` flag.
- **Two principal types** — users (Supabase JWT) and API keys (issued by
  miramira, hashed in PostgreSQL).
- **Bulk permission checks** — `POST /check/batch` answers up to 100 checks
  in one round-trip.
- **Effective permissions** — `GET /me/permissions` returns every scope the
  caller holds at every tenant; ideal for hydrating client-side UIs.
- **Audit log** — every mutating request is recorded with same-transaction
  guarantees and a full before/after row snapshot.
- **OpenAPI 3.1** spec generated from the same Zod schemas the runtime uses
  for validation. Browse at `/docs`; fetch at `/openapi.json`.
- **Transactional outbox** — DB writes and OpenFGA tuple updates stay in sync
  via an outbox table + worker, no two-phase commit required.

## Quickstart

```bash
# 1. Bring up Postgres + OpenFGA (Docker required)
docker compose up -d --wait

# 2. Install deps and apply schema
npm install
cp .env.example .env
npm run db:migrate
npm run openfga:bootstrap    # writes the OpenFGA model; prints store/model IDs
# paste OPENFGA_STORE_ID and OPENFGA_AUTHORIZATION_MODEL_ID into .env

# 3. Seed the system data and (optionally) a bootstrap admin
echo "BOOTSTRAP_ADMIN_EMAIL=you@example.com" >> .env
npm run db:seed

# 4. Run the API + worker
npm run dev          # in one terminal — serves on http://localhost:4000
npm run worker       # in another — drains the outbox to OpenFGA
```

Open <http://localhost:4000/docs> for the interactive Swagger UI.

### Running with Docker only

```bash
# Run the whole stack (Postgres + OpenFGA + miramira) from images.
export OPENFGA_STORE_ID=... OPENFGA_AUTHORIZATION_MODEL_ID=...
export SUPABASE_JWKS_URL=... SUPABASE_JWT_ISSUER=...
export CORS_ALLOWED_ORIGINS=https://app.example.com
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Configuration

All configuration is environment-driven. See [`.env.example`](.env.example)
for the full list with defaults.

| Variable                          | Required | Notes                                                                                  |
|-----------------------------------|----------|----------------------------------------------------------------------------------------|
| `DATABASE_URL`                    | yes      | Postgres 16+ connection string                                                         |
| `OPENFGA_API_URL`                 | yes      | OpenFGA HTTP endpoint                                                                  |
| `OPENFGA_STORE_ID`                | yes      | Produced by `npm run openfga:bootstrap`                                                |
| `OPENFGA_AUTHORIZATION_MODEL_ID`  | yes      | Produced by `npm run openfga:bootstrap`                                                |
| `SUPABASE_JWKS_URL`               | yes      | Public JWKS URL for Supabase project                                                   |
| `SUPABASE_JWT_ISSUER`             | yes      | Supabase project URL (issuer claim)                                                    |
| `SUPABASE_JWT_AUDIENCE`           | no       | Defaults to `authenticated`                                                            |
| `CORS_ALLOWED_ORIGINS`            | prod     | Comma-separated. Required when `NODE_ENV=production`.                                  |
| `BOOTSTRAP_ADMIN_EMAIL`           | no       | If set, `db:seed` grants admin at the master tenant. Without it, every request 403s.   |
| `SUPABASE_WEBHOOK_SECRET`         | no       | When set, registers `POST /webhooks/supabase` for Supabase Auth Hook events. Standard Webhooks signed. |
| `METRICS_PORT`                    | no       | Worker's `/metrics` port (default `9090`). API server exposes `/metrics` on its main port. |
| `HOST` / `PORT` / `LOG_LEVEL`     | no       | Defaults: `0.0.0.0`, `4000`, `info`                                                    |

## Authentication

Routes accept either of two credentials. When both are present, `X-API-Key`
wins with no fallback.

- **Bearer JWT** — `Authorization: Bearer <jwt>`, verified against the
  configured Supabase JWKS.
- **API key** — `X-API-Key: <secret>`, issued via `POST /api-keys` and
  stored as a SHA-256 hash. Returned exactly once at creation time.

The full security scheme declaration is part of the OpenAPI spec, so
generated SDKs honour either mechanism.

## Architecture

A short tour:

```
HTTP request
  → routes/        Zod-validated, dogfooded authz (requireAuth + requireScope)
  → services/      business logic; opens DB transactions
  → repositories/  Drizzle queries
  → db/            schema + migrations + seeds
  → openfga/       FGA client wrapper

worker (separate process)
  → drains outbox_events → openfga/
```

The service layer is the only layer that touches both PostgreSQL and OpenFGA.
Dual writes use the transactional outbox: every mutating request commits a
business row plus an outbox row in the same DB transaction. A worker process
delivers outbox events to OpenFGA. Failed deliveries retry with exponential
backoff.

Deeper docs:

- [`docs/openapi.md`](docs/openapi.md) — generated spec, pagination, SDK
  generation recipes
- [`docs/audit-log.md`](docs/audit-log.md) — audit table shape, retention
- [`docs/observability.md`](docs/observability.md) — structured logs + Prometheus `/metrics`
- [`CLAUDE.md`](CLAUDE.md) — high-level domain model and folder layout

## Development

```bash
npm run dev              # API on :4000, hot-reloads from src/
npm run worker           # outbox → OpenFGA delivery
npm test                 # vitest (integration tests need Docker)
npm run typecheck
npm run lint
npm run format           # prettier
npm run db:generate      # drizzle-kit: produce a new migration
npm run db:migrate       # drizzle-kit: apply migrations locally
npm run db:migrate:apply # runtime migrate (used in containers)
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Chris Carrington.
