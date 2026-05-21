# miramira Helm chart

Deploys the miramira authorization service: a Fastify **api** Deployment, an
outbox **worker** Deployment, and an in-cluster **OpenFGA** (subchart) backed by
your managed Postgres. Database migrations and OpenFGA store/model bootstrap run
as Helm-hook Jobs.

## Prerequisites

- A **managed Postgres** instance with two databases: one for miramira, one for
  OpenFGA (e.g. `miramira` and `openfga`). Create them before installing.
- A built image pushed to `image.repository` (CI does this — see
  `.github/workflows/ci.yml`).
- `kubectl` access and Helm 3.8+ (the IDs Secret uses `lookup`).
- For the OpenFGA subchart: `helm dependency update deploy/helm/miramira`.

## Required values

| Value | What |
|---|---|
| `image.repository` | where CI pushed the image |
| `appSecret.databaseUrl` *(or `appSecret.existingSecret`)* | miramira Postgres URL |
| `openfga.datastore.uri` *(prefer a secret ref)* | OpenFGA Postgres URL (separate DB) |
| `config.corsAllowedOrigins` | comma-separated origins (required in production) |
| `config.supabaseJwksUrl` / `supabaseJwtIssuer` | Supabase JWT verification |

Secrets: prefer `appSecret.existingSecret` (keys `DATABASE_URL`,
`SUPABASE_WEBHOOK_SECRET`) and a pre-created secret for the OpenFGA datastore
URI, rather than putting credentials in `values.yaml`.

## Install

From the published Helm repo (OpenFGA is bundled in the package):

```sh
helm repo add megafarad https://megafarad.github.io/helm-charts
helm repo update

helm upgrade --install miramira megafarad/miramira \
  --namespace miramira --create-namespace \
  -f my-values.yaml
```

Or from a source checkout:

```sh
helm dependency update deploy/helm/miramira

helm upgrade --install miramira deploy/helm/miramira \
  --namespace miramira --create-namespace \
  -f my-values.yaml
```

### Releasing a new chart version

Bump `version:` in `Chart.yaml`, then push a matching tag — the
`publish-helm` workflow packages and pushes it to the repo above:

```sh
git tag helm-v0.2.0 && git push origin helm-v0.2.0
```

## How bootstrap / ordering works

1. **pre-install/pre-upgrade** — `*-migrate` Job runs `node dist/db/migrate.js`.
2. **main** — OpenFGA + api/worker roll out. `/readyz` keeps api out of the
   load balancer until Postgres, OpenFGA, and migrations all check out.
3. **post-install/post-upgrade** — `*-openfga-bootstrap` Job waits for OpenFGA,
   creates/reuses the `miramira` store, writes the current authorization model,
   patches the IDs into the `*-openfga-ids` Secret, and `kubectl rollout
   restart`s api/worker so they pick up the model ID.

The IDs Secret is seeded from its already-applied value via `lookup` and marked
`helm.sh/resource-policy: keep`, so upgrades and uninstalls never discard the
store/model the Job wrote. The store is **reused** across upgrades; the model is
re-written each upgrade to match the code (a new immutable model version), and
the rollout restart points the app at it.

> First install only: api/worker may crashloop briefly until the bootstrap Job
> writes the model ID and restarts them. This self-heals.

## Notes

- `/metrics` is unauthenticated on both api and worker — scrape it in-cluster
  (enable `metrics.serviceMonitor.enabled` with the Prometheus Operator); do not
  expose it via ingress.
- Rate limiting is in-memory per replica (limits are effectively per-pod, not
  global). Front with a shared store if you need global limits.
- Pin `image.tag` to a digest in production rather than relying on `appVersion`.
