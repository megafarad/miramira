# Audit log

miramira records every successful mutating API call in the `audit_log` table.
The entry is written inside the **same database transaction** as the business
write — either both commit or neither does. You can never observe a state
change without a corresponding audit row, and you can never observe an audit
row for a change that didn't happen.

## Schema

```sql
CREATE TABLE audit_log (
  id                 uuid PRIMARY KEY,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  actor_principal_id uuid REFERENCES principals(id) ON DELETE SET NULL,
  actor_kind         text,         -- 'user' | 'api_key' | NULL
  request_id         text NOT NULL,
  method             text NOT NULL,
  route              text NOT NULL,
  action             text NOT NULL,
  target_type        text NOT NULL,
  target_id          uuid,
  tenant_id          uuid REFERENCES tenants(id) ON DELETE SET NULL,
  before             jsonb,
  after              jsonb,
  ip                 text,
  user_agent         text
);
```

Indexes are tuned for the queries you'll actually run:
`(target_type, target_id, created_at DESC)`,
partial `(actor_principal_id, created_at DESC)`,
partial `(tenant_id, created_at DESC)`,
plus a flat `(created_at DESC)`.

## Conventional actions

Built-in actions emitted by miramira are constants in
`src/services/audit-actions.ts`:

| Action | Method | Route shape |
|---|---|---|
| `tenant.create` | POST | `/tenants` |
| `tenant.update` | PATCH | `/tenants/:id` |
| `role.create` | POST | `/tenants/:tenantId/roles` |
| `role.update` | PATCH | `/roles/:id` |
| `role.scope_add` | POST | `/roles/:id/scopes` |
| `role.scope_remove` | DELETE | `/roles/:id/scopes/:scopeId` |
| `scope.create` | POST | `/tenants/:tenantId/scopes` |
| `scope.update` | PATCH | `/scopes/:id` |
| `api_key.create` | POST | `/api-keys` |
| `api_key.revoke` | DELETE | `/api-keys/:id` |
| `role_binding.create` | POST | `/role-bindings` |
| `role_binding.revoke` | DELETE | `/role-bindings/:id` |

`action` is a free-form `text` column, not a Postgres enum, so plugin authors
who add their own mutating endpoints can use any namespace they like
(e.g., `myorg.feature_flag.set`). Convention: dot-separated, snake_case, first
segment is the resource type.

## Snapshot shape

`before` and `after` are JSONB. Their shape is per-action:

- **Most resources** (`tenant`, `role`, `scope`, `api_key`, `role_binding`):
  the full Drizzle row. `before` is `null` for creates; `after` is the post-
  mutation row for revokes (so you can see the `revoked_at` timestamp and the
  state right before deletion-flag).
- **`role.scope_add` / `role.scope_remove`**: snapshots of the role's full
  scope membership: `{ "scopeIds": ["...", "..."] }`, sorted. Lets you
  reconstruct what the role granted at any point.
- **`api_key.create`**: the `api_keys` row only — the one-time `secret` is
  **never** persisted to audit. The row's `key_hash` is present but is a hash,
  not the secret.

## What's NOT audited

- **Reads** (`GET /*`) — too noisy, not state-changing.
- **`POST /check`** — high-volume permission probe; security-relevant attempts
  are visible in structured logs, but each successful check would balloon the
  audit table.
- **Failed mutations** (401 / 403 / 400 / 409 / 5xx) — visible in structured
  logs (`{ msg: 'request', status: 403, principalId, route }`). The audit log
  is the record of *what happened*, not *what was attempted*.
- **Seed-script writes** (`npm run db:seed`) — no HTTP actor; the bootstrap
  admin binding is pre-history. The first audit row appears with the first
  HTTP mutation.

## Querying recipes

```sql
-- Recent changes across the system.
SELECT created_at, action, actor_principal_id, target_type, target_id
FROM audit_log
ORDER BY created_at DESC
LIMIT 50;

-- Full history for one tenant.
SELECT created_at, action, before, after
FROM audit_log
WHERE tenant_id = :tenant
ORDER BY created_at;

-- Who has bound roles in the last week, anywhere?
SELECT created_at, actor_principal_id, target_id, after->>'principalId' AS bound_principal,
       after->>'roleId' AS role
FROM audit_log
WHERE action = 'role_binding.create'
  AND created_at > now() - interval '7 days'
ORDER BY created_at DESC;

-- All actions by a specific principal.
SELECT created_at, action, target_type, target_id
FROM audit_log
WHERE actor_principal_id = :principal
ORDER BY created_at DESC;

-- Reconstruct a role's scope-membership history.
SELECT created_at, action, before->'scopeIds' AS before_scopes,
       after->'scopeIds' AS after_scopes
FROM audit_log
WHERE target_type = 'role' AND target_id = :role
  AND action IN ('role.scope_add', 'role.scope_remove')
ORDER BY created_at;
```

## Adding custom audit actions

If you're extending miramira with your own mutating routes:

1. Import the request-context shape and helpers:
   ```ts
   import type { AuditRequestContext } from 'miramira/plugins/audit';
   import { AuditLogRepository } from 'miramira/repositories/audit-log';
   ```

2. In your service method, accept an optional `audit?: AuditRequestContext`
   parameter and insert inside the same `db.transaction` as your business
   write:
   ```ts
   async myMutation(input, audit?: AuditRequestContext) {
     return this.deps.db.transaction(async (tx) => {
       const result = await /* your work */;
       if (audit) {
         await new AuditLogRepository(tx).insert({
           ...audit,
           action: 'myorg.feature_flag.set',
           targetType: 'feature_flag',
           targetId: result.id,
           tenantId: input.tenantId,
           before: null,
           after: result,
         });
       }
       return result;
     });
   }
   ```

3. In your route handler, just pass `req.auditContext()`:
   ```ts
   await deps.myService.myMutation(input, req.auditContext());
   ```

The transactional guarantee carries through automatically — the audit row
commits with your business write or both roll back.

## Retention

miramira does not auto-truncate `audit_log`. Operators own retention policy.
Common patterns:

- **Indefinite** — leave it; the table grows linearly with mutation volume
  and is cheap to query.
- **Time-based partitioning** — convert to a partitioned table by month and
  drop old partitions (`pg_partman` or manual). Recommended past ~10M rows.
- **Cold storage** — periodically `COPY` to object storage and `DELETE` rows
  older than N days. Suits compliance frameworks that require offline
  archives.

## Privacy

Full row snapshots include any data on the row, including emails (in
`users`-shaped after-snapshots on principal-related events). The audit log is
intended for the operator running miramira, not for end users. Treat the
table as internal-admin-only. Plugin authors writing custom audits with
sensitive fields are responsible for redacting before insertion if needed.
