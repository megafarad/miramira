// Prometheus instrumentation plugin for the HTTP server.
//
// - Observes every request's latency and increments a per-(method, route,
//   status) counter on the response hook.
// - Exposes GET /metrics returning the Prometheus exposition format.
//
// Cardinality: we label by Fastify route template (e.g. `/tenants/:id`), not
// raw URL — bounded by route count. Requests that don't match any route
// (true 404s) get route="<unknown>" so they can't blow up the label set with
// scanner traffic.
//
// Note: /metrics intentionally returns Prometheus text, not the {data: T}
// envelope used elsewhere in the API. This is the standard exposition format
// — documented exception to api-design.md.

import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { Metrics } from '../lib/metrics.js';

export interface MetricsPluginOptions {
  metrics: Metrics;
}

// Endpoints excluded from per-request instrumentation so the histogram isn't
// dominated by probe traffic. /metrics itself must be skipped to avoid
// recursion (scraping increments a counter for the scrape).
const SKIP_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

const metricsPluginInner: FastifyPluginAsync<MetricsPluginOptions> = async (app, opts) => {
  const { metrics } = opts;

  app.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?', 1)[0] ?? '';
    if (SKIP_PATHS.has(path)) return;

    const route = req.routeOptions?.url ?? '<unknown>';
    const labels = {
      method: req.method,
      route,
      status: String(reply.statusCode),
    };
    metrics.httpRequestsTotal.inc(labels);
    metrics.httpRequestDurationMs.observe(labels, reply.elapsedTime);
  });

  app.get('/metrics', async (_req, reply) => {
    const body = await metrics.registry.metrics();
    reply.header('content-type', metrics.registry.contentType);
    return body;
  });
};

// fp() so the onResponse hook applies to every route, not just routes
// registered inside this plugin's encapsulation context.
export const metricsPlugin = fp(metricsPluginInner, { name: 'metrics' });
