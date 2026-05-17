import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Env } from '../src/config/env.js';
import type { FgaClient } from '../src/openfga/client.js';

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
};

describe('health routes (no downstreams wired)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ env: testEnv });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /healthz returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz reports ready with no checks when no downstreams configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: {} });
  });
});

describe('health routes (with FGA stub)', () => {
  let app: FastifyInstance;

  const okFga: FgaClient = {
    writeTuples: async () => undefined,
    deleteTuples: async () => undefined,
    check: async () => false,
    listObjects: async () => [],
    readinessProbe: async () => ({ healthy: true, latencyMs: 1 }),
  };

  beforeAll(async () => {
    app = await buildApp({ env: testEnv, fga: okFga });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /readyz includes openfga check', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; checks: Record<string, { healthy: boolean }> }>();
    expect(body.status).toBe('ready');
    expect(body.checks.openfga?.healthy).toBe(true);
  });

  it('GET /readyz returns 503 when FGA reports unhealthy', async () => {
    const unhealthyApp = await buildApp({
      env: testEnv,
      fga: {
        ...okFga,
        readinessProbe: async () => ({ healthy: false, latencyMs: 5 }),
      },
    });
    await unhealthyApp.ready();
    const res = await unhealthyApp.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    await unhealthyApp.close();
  });
});
