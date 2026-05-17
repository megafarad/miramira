# Observability

miramira emits structured JSON logs via [pino](https://getpino.io/). One line
per request, plus per-error lines on unhandled failures and worker-loop
events.

## Per-request log

The `logging` plugin emits one line at request completion via Fastify's
`onResponse` hook. Level depends on outcome:

- `info` for 2xx
- `warn` for 4xx
- `error` for 5xx

Skipped: `/healthz` and `/readyz` (load-balancer probes — too noisy to log).

Example:

```json
{
  "level": 30,
  "time": 1731234567890,
  "pid": 12345,
  "hostname": "miramira-1",
  "reqId": "req-7",
  "msg": "request",
  "method": "POST",
  "url": "/tenants",
  "statusCode": 200,
  "latencyMs": 23.4,
  "principalId": "019e2e5d-...",
  "principalKind": "user"
}
```

The `reqId` field is also persisted to `audit_log.request_id` for any
mutating call. Use it to correlate a single business action across:

- The structured log line (outcome)
- The audit row (what changed)
- Any worker logs that materialized downstream effects (search by binding ID)

## Failure modes

| Outcome | Log level | Logged where |
|---|---|---|
| 200/201/204 success | `info` | `onResponse` only |
| 400 (Zod / ValidationError) | `warn` | `onResponse` only |
| 401 (AuthError) | `warn` | `onResponse` only |
| 403 (ForbiddenError) | `warn` | `onResponse` only |
| 404 (NotFoundError) | `warn` | `onResponse` only |
| 409 (ConflictError) | `warn` | `onResponse` only |
| 5xx (unexpected) | `error` | `errorHandler` logs the stack, then `onResponse` logs the outcome |

Domain errors (`AuthError`, `ForbiddenError`, etc.) intentionally do NOT log
a stack at error level — they're routine outcomes. If a 5xx surfaces, the
`errorHandler` logs the full error object before returning the response.

## Per-request context

`req.id` is the Fastify-assigned request ID (auto-generated per request,
or sourced from the `Request-Id` header if set). It's automatically included
in any `req.log.*(...)` call. Pino's child-logger mechanism could enrich
this further if a future phase wants to add `principalId` to every log
line within a request (currently it's added only to the per-request outcome
line).

## Worker logs

The outbox worker (`npm run worker`) logs:

- `info { msg: 'worker started' }` at startup
- `info { msg: 'worker shutdown signal received', signal, timeoutMs }` on
  SIGINT/SIGTERM
- `info { msg: 'worker stopped' }` after a clean drain
- `warn { eventId, attempts, retryAt, err }` when an event delivery fails;
  the event is requeued with exponential backoff
- `error { eventId, attempts, eventType, aggregateType, aggregateId, payload,
  err }` when an event has failed `maxAttempts` times and is moved to the
  dead-letter state. **Wire this to your alerting** — a dead event means
  authorization state in OpenFGA has diverged from PostgreSQL until an
  operator intervenes.
- `error { err }` when the claim loop itself fails (e.g., DB connection lost)

Workers don't write to `audit_log` directly — they materialize FGA tuples,
which is a delivery concern, not a state change in miramira's domain model.
The original mutation that enqueued the outbox event was already audited.

## Dead-letter queue

Events that exceed `maxAttempts` failures (default **10**, configurable in
`src/lib/backoff.ts`) are retired to the dead-letter state via a `dead_at`
timestamp on the `outbox_events` row. Dead events are excluded from
`claimBatch` and stop consuming worker cycles.

### Inspecting dead events

```sql
SELECT id, event_type, aggregate_id, attempts, last_error, created_at, dead_at
FROM outbox_events
WHERE dead_at IS NOT NULL
ORDER BY dead_at DESC;
```

The full payload is in the `payload` JSONB column.

### Reviving a dead event

After diagnosing and fixing the root cause (an OpenFGA model mismatch, a
network ACL, a bug in the materializer, etc.), revive the event by clearing
the dead state and resetting the retry schedule:

```sql
UPDATE outbox_events
SET dead_at = NULL,
    attempts = 0,
    last_error = NULL,
    next_retry_at = now()
WHERE id = '<event-id>';
```

The worker will pick it up on its next iteration. Verify success by
checking that the row's `processed_at` is set within ~`idlePollMs`.

### Why no HTTP admin endpoint?

Deferred. The right access controls (new system scope? master-tenant only?
multi-step confirmation for revive?) deserve a dedicated phase. For now,
operators have direct DB access and can use the queries above.

## Shutdown behavior

Both the HTTP server (`npm start`) and the outbox worker (`npm run worker`)
handle SIGINT and SIGTERM gracefully:

- The HTTP server calls `app.close()`, which stops accepting new connections
  and drains in-flight requests. Then it closes the Postgres pool.
- The worker aborts the run loop. The current batch finishes the in-flight
  event but does not pick up the next one in the batch. Claimed-but-not-yet-
  processed events keep their bumped `attempts` count; they become eligible
  on the next worker start once `next_retry_at` passes.

Both drains are wrapped in a `SHUTDOWN_TIMEOUT_MS` watchdog (default 30s,
matching k8s' `terminationGracePeriodSeconds`). If the drain doesn't
complete in time, the process logs an error and exits non-zero — better
than hanging until the orchestrator SIGKILLs without a trace.

## Sensitive fields

By default, Fastify does NOT log request or response bodies. miramira does
not enable body logging. The only meaningfully sensitive piece of data the
API ever surfaces is the one-time `secret` returned from `POST /api-keys`;
it's in the response body and is never written to any log or to
`audit_log.after`.

If you enable request-body logging via custom Fastify configuration, scrub
the `X-API-Key` header and the response body of `POST /api-keys` before
shipping logs to a SIEM.

## Log levels in different environments

Controlled by the `LOG_LEVEL` env var (parsed in `src/config/env.ts`):

- `development` defaults to `info`, with `pino-pretty` formatting for
  readability.
- `production` should run at `info` for normal operations; downgrade to
  `warn` if log volume becomes a problem.
- `test` uses `silent` to keep test output clean.
- `LOG_LEVEL=debug` enables Drizzle query logging via the underlying
  `postgres` driver if you've enabled it there.

## What's NOT instrumented (yet)

- **Prometheus / OpenMetrics endpoint** — no metrics emitter today. A future
  phase could add `/metrics` with request counters, latency histograms, and
  worker queue depth gauges.
- **Distributed tracing** — no OpenTelemetry integration. Request IDs
  provide enough correlation for single-service debugging; tracing matters
  more once miramira is fronted by an API gateway or sits in a service mesh.
- **Per-route rate-limit metrics** — `@fastify/rate-limit` exposes some;
  not surfaced.
