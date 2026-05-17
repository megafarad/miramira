import type { FastifyPluginAsync } from 'fastify';
import type { FgaClient } from '../openfga/client.js';
import type { Database } from '../db/client.js';
import { sql } from 'drizzle-orm';

export interface HealthRoutesOptions {
  // Explicit `| undefined` so callers may spread `{ fga: maybeFga }` without
  // tripping `exactOptionalPropertyTypes`.
  fga?: FgaClient | undefined;
  db?: Database | undefined;
}

export const healthRoutes = (opts: HealthRoutesOptions = {}): FastifyPluginAsync => {
  return async (app) => {
    // Liveness: trivial — the process is up.
    app.get('/healthz', async () => ({ status: 'ok' }));

    // Readiness: report on each downstream we know about. 503 if any are
    // configured-but-unhealthy.
    app.get('/readyz', async (_req, reply) => {
      const checks: Record<string, { healthy: boolean; latencyMs: number }> = {};

      if (opts.fga) {
        checks.openfga = await opts.fga.readinessProbe();
      }
      if (opts.db) {
        const start = Date.now();
        try {
          await opts.db.execute(sql`SELECT 1`);
          checks.postgres = { healthy: true, latencyMs: Date.now() - start };
        } catch {
          checks.postgres = { healthy: false, latencyMs: Date.now() - start };
        }
      }

      const allHealthy = Object.values(checks).every((c) => c.healthy);
      if (!allHealthy) {
        return reply.code(503).send({ status: 'unready', checks });
      }
      return { status: 'ready', checks };
    });
  };
};
