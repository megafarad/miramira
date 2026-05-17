import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

// Endpoints that get hit by load balancers / k8s probes. Skipping them keeps
// info logs focused on real activity without losing audit-relevant traffic.
const HEALTH_PATHS = new Set(['/healthz', '/readyz']);

const loggingPluginInner: FastifyPluginAsync = async (app) => {
  app.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?', 1)[0] ?? '';
    if (HEALTH_PATHS.has(path)) return;

    const status = reply.statusCode;
    const ctx = {
      method: req.method,
      url: req.url,
      statusCode: status,
      latencyMs: reply.elapsedTime,
      principalId: req.principal?.id ?? null,
      principalKind: req.principal?.kind ?? null,
    };
    if (status >= 500) req.log.error(ctx, 'request');
    else if (status >= 400) req.log.warn(ctx, 'request');
    else req.log.info(ctx, 'request');
  });
};

export const loggingPlugin = fp(loggingPluginInner, { name: 'logging' });
