import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Env } from '../src/config/env.js';

const baseEnv: Env = {
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
  CORS_ALLOWED_ORIGINS: ['https://app.example.com', 'http://localhost:5173'],
  SHUTDOWN_TIMEOUT_MS: 30_000,
};

describe('CORS plugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ env: baseEnv });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('preflight from an allowed origin returns 204 with the proper CORS headers', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-api-key',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const allowedHeaders = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    expect(allowedHeaders).toContain('x-api-key');
    expect(allowedHeaders).toContain('authorization');
    expect(allowedHeaders).toContain('content-type');
  });

  it('preflight from a disallowed origin does not echo the origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('actual GET from an allowed origin gets the Allow-Origin header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
