// Prometheus metrics registry shared by the HTTP server and the worker
// process. Each process builds its own registry via `createMetricsRegistry()`
// and passes the resulting `Metrics` bundle into anything that should emit.
//
// Naming: `<subsystem>_<unit_or_action>[_unit]`. Histograms end in `_ms` so
// the unit is unambiguous on the wire. Counters are pluralized and end in
// `_total` per Prometheus convention. Gauges are singular.

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;

  // HTTP — labels: method, route (Fastify route template), status (numeric).
  httpRequestsTotal: Counter<'method' | 'route' | 'status'>;
  httpRequestDurationMs: Histogram<'method' | 'route' | 'status'>;

  // Outbox worker — per-batch counters and a batch-duration histogram.
  outboxBatchClaimedTotal: Counter<string>;
  outboxEventsAckedTotal: Counter<string>;
  outboxEventsFailedTotal: Counter<string>;
  outboxEventsDeadTotal: Counter<string>;
  outboxBatchDurationMs: Histogram<string>;

  // Outbox queue depth — refreshed on a timer by the worker's gauge collector.
  // Surfaces lag without spamming on every event.
  outboxPending: Gauge<string>;
  outboxDead: Gauge<string>;
  outboxOldestPendingAgeMs: Gauge<string>;

  // OpenFGA — wrapped by MetricsFgaClient. Lets us tell apart "FGA is slow"
  // from "the worker is slow at dispatching to FGA".
  fgaCallTotal: Counter<'op' | 'outcome'>;
  fgaCallDurationMs: Histogram<'op'>;
}

// Bucket sets tuned for in-VPC latencies. HTTP includes a long tail because
// some routes do dependent FGA writes; outbox batches dominate the tens of ms.
const HTTP_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500];
const BATCH_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const FGA_BUCKETS_MS = [2, 5, 10, 25, 50, 100, 250, 500, 1000];

export function createMetricsRegistry(): Metrics {
  const registry = new Registry();

  // Node-level metrics (event loop lag, GC, heap, RSS, FDs). Cheap, very
  // useful for diagnosing "is this a Node problem or our problem?".
  collectDefaultMetrics({ register: registry });

  return {
    registry,

    httpRequestsTotal: new Counter({
      name: 'http_requests_total',
      help: 'Count of HTTP requests handled by the API server.',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    httpRequestDurationMs: new Histogram({
      name: 'http_request_duration_ms',
      help: 'HTTP request latency in milliseconds.',
      labelNames: ['method', 'route', 'status'],
      buckets: HTTP_BUCKETS_MS,
      registers: [registry],
    }),

    outboxBatchClaimedTotal: new Counter({
      name: 'outbox_batch_claimed_total',
      help: 'Sum of events claimed across all batches.',
      registers: [registry],
    }),
    outboxEventsAckedTotal: new Counter({
      name: 'outbox_events_acked_total',
      help: 'Events successfully delivered and acked.',
      registers: [registry],
    }),
    outboxEventsFailedTotal: new Counter({
      name: 'outbox_events_failed_total',
      help: 'Events that failed delivery and were scheduled for retry.',
      registers: [registry],
    }),
    outboxEventsDeadTotal: new Counter({
      name: 'outbox_events_dead_total',
      help: 'Events that crossed maxAttempts and were moved to the dead-letter state.',
      registers: [registry],
    }),
    outboxBatchDurationMs: new Histogram({
      name: 'outbox_batch_duration_ms',
      help: 'Wall-clock time spent processing a single claimed batch.',
      buckets: BATCH_BUCKETS_MS,
      registers: [registry],
    }),

    outboxPending: new Gauge({
      name: 'outbox_pending',
      help: 'Events awaiting delivery (processed_at IS NULL AND dead_at IS NULL).',
      registers: [registry],
    }),
    outboxDead: new Gauge({
      name: 'outbox_dead',
      help: 'Events in the dead-letter state (dead_at IS NOT NULL).',
      registers: [registry],
    }),
    outboxOldestPendingAgeMs: new Gauge({
      name: 'outbox_oldest_pending_age_ms',
      help: 'Age in ms of the oldest pending event (now - min(next_retry_at)).',
      registers: [registry],
    }),

    fgaCallTotal: new Counter({
      name: 'fga_call_total',
      help: 'OpenFGA client calls grouped by operation and outcome.',
      labelNames: ['op', 'outcome'],
      registers: [registry],
    }),
    fgaCallDurationMs: new Histogram({
      name: 'fga_call_duration_ms',
      help: 'OpenFGA client call latency in milliseconds.',
      labelNames: ['op'],
      buckets: FGA_BUCKETS_MS,
      registers: [registry],
    }),
  };
}
