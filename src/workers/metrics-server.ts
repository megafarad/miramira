// Tiny Fastify app the worker process runs alongside its outbox loop so
// Prometheus can scrape worker-side counters and gauges. Independent from
// the main API server because the worker is a separate process — no port to
// piggyback on.
//
// Surface is intentionally tiny: /metrics + /healthz. No auth (same posture
// as the main /metrics route — operate behind a private network).

import Fastify, { type FastifyInstance } from 'fastify';
import type { Metrics } from '../lib/metrics.js';

export interface WorkerMetricsServerOptions {
  metrics: Metrics;
  host: string;
  port: number;
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

export async function startWorkerMetricsServer(
  opts: WorkerMetricsServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/metrics', async (_req, reply) => {
    const body = await opts.metrics.registry.metrics();
    reply.header('content-type', opts.metrics.registry.contentType);
    return body;
  });

  await app.listen({ host: opts.host, port: opts.port });
  opts.logger?.info({ host: opts.host, port: opts.port }, 'worker metrics server listening');
  return app;
}
