import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';

const HEALTH_PATHS = new Set(['/healthz', '/readyz']);

const rateLimitPluginInner: FastifyPluginAsync = async (app) => {
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    // Health endpoints are polled by load balancers / k8s — never throttle them.
    skipOnError: false,
    allowList: (req) => HEALTH_PATHS.has(req.url.split('?', 1)[0] ?? ''),
  });
};

export const rateLimitPlugin = fp(rateLimitPluginInner, { name: 'rate-limit' });
