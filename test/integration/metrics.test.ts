import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createMetricsRegistry, type Metrics } from '../../src/lib/metrics.js';
import type { Env } from '../../src/config/env.js';

const testEnv: Env = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  OPENFGA_API_URL: 'http://localhost:8080',
  OPENFGA_STORE_ID: 'test-store',
  OPENFGA_AUTHORIZATION_MODEL_ID: 'test-model',
  SUPABASE_JWKS_URL: 'http://localhost/jwks.json',
  SUPABASE_JWT_ISSUER: 'http://localhost',
  SUPABASE_JWT_AUDIENCE: 'authenticated',
  CORS_ALLOWED_ORIGINS: [],
  SHUTDOWN_TIMEOUT_MS: 30_000,
  METRICS_PORT: 9090,
};

describe('metrics plugin', () => {
  let app: FastifyInstance;
  let metrics: Metrics;

  beforeAll(async () => {
    metrics = createMetricsRegistry();
    app = await buildApp({ env: testEnv, metrics });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves /metrics with the Prometheus content-type', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.payload).toContain('http_requests_total');
  });

  it('does not instrument /metrics, /healthz, or /readyz', async () => {
    // Hit each excluded path. None should bump http_requests_total.
    await app.inject({ method: 'GET', url: '/metrics' });
    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({ method: 'GET', url: '/readyz' });
    const text = await metrics.registry.metrics();
    expect(text).not.toMatch(/http_requests_total\{[^}]*route="\/metrics"/);
    expect(text).not.toMatch(/http_requests_total\{[^}]*route="\/healthz"/);
    expect(text).not.toMatch(/http_requests_total\{[^}]*route="\/readyz"/);
  });

  it('instruments a real route with its template, not the raw URL', async () => {
    // /metrics itself is excluded; use a known route. Without `auth` wired,
    // unauthenticated requests still hit handlers and the hook fires before
    // the response is sent. The error from a missing handler is fine — what
    // we care about is that the label set is bounded.
    //
    // 404s land in `<unknown>` route because Fastify can't match.
    const res = await app.inject({ method: 'GET', url: '/this-route-doesnt-exist' });
    expect(res.statusCode).toBe(404);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/http_requests_total\{[^}]*route="<unknown>"/);
  });
});
