import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { createTestJwtContext, type TestJwtContext } from '../_helpers/fake-jwt.js';
import { buildApp } from '../../src/app.js';
import { ApiKeysRepository } from '../../src/repositories/api-keys.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { AuthenticationServiceImpl } from '../../src/services/authentication.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';
import type { Env } from '../../src/config/env.js';

describe.skipIf(!(await isDbReachable()))('auth plugin + /me (integration)', () => {
  let app: FastifyInstance;
  let users: UsersRepository;
  let apiKeys: ApiKeysRepository;
  let jwt: TestJwtContext;

  const env: Env = {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    OPENFGA_API_URL: 'http://localhost:8080',
    OPENFGA_STORE_ID: 'test-store',
    OPENFGA_AUTHORIZATION_MODEL_ID: 'test-model',
    SUPABASE_JWKS_URL: 'http://localhost/jwks.json',
    SUPABASE_JWT_ISSUER: 'https://test.local/auth/v1',
    SUPABASE_JWT_AUDIENCE: 'authenticated',
    CORS_ALLOWED_ORIGINS: [],
    SHUTDOWN_TIMEOUT_MS: 30_000,
  };

  beforeAll(async () => {
    const { db } = getTestDb();
    users = new UsersRepository(db);
    apiKeys = new ApiKeysRepository(db);
    const principals = new PrincipalsRepository(db);
    jwt = await createTestJwtContext({ issuer: env.SUPABASE_JWT_ISSUER });
    const auth = new AuthenticationServiceImpl({
      users,
      apiKeys,
      principals,
      jwks: jwt.jwks,
      jwtIssuer: jwt.issuer,
      jwtAudience: jwt.audience,
    });
    app = await buildApp({ env, auth });
    await app.ready();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  interface MeResponse {
    data: { kind: 'user' | 'api_key'; userId: string | null; apiKeyId: string | null };
  }
  interface ErrResponse {
    error: string;
  }

  it('GET /me with no credentials returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json<ErrResponse>().error).toMatch(/missing credentials/i);
  });

  it('rejects an Authorization header that is not Bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Basic Zm9vOmJhcg==' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid X-API-Key and returns an api_key principal', async () => {
    const { secret, row } = await apiKeys.create({
      label: 'plugin test',
      tenantId: MASTER_TENANT_ID,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { 'x-api-key': secret },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<MeResponse>();
    expect(body.data.kind).toBe('api_key');
    expect(body.data.apiKeyId).toBe(row.id);
  });

  it('accepts a valid Bearer JWT and returns a user principal (auto-provisioned)', async () => {
    const token = await jwt.sign({ sub: 'sub-from-plugin', email: 'plugin@example.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<MeResponse>();
    expect(body.data.kind).toBe('user');
    expect(body.data.userId).not.toBeNull();
    const refreshed = await users.findBySupabaseId('sub-from-plugin');
    expect(refreshed?.email).toBe('plugin@example.com');
  });

  it('when both headers are present, the API key wins (JWT is ignored)', async () => {
    const { secret, row } = await apiKeys.create({ label: 'wins', tenantId: MASTER_TENANT_ID });
    const token = await jwt.sign({ sub: 'sub-ignored', email: 'ignored@example.com' });

    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { 'x-api-key': secret, authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<MeResponse>();
    expect(body.data.kind).toBe('api_key');
    expect(body.data.apiKeyId).toBe(row.id);

    // The JWT must NOT have caused user auto-provisioning, since it was ignored.
    expect(await users.findBySupabaseId('sub-ignored')).toBeUndefined();
  });

  it('a revoked X-API-Key returns 401 and does NOT fall through to the Bearer token', async () => {
    const { secret, row } = await apiKeys.create({
      label: 'revoked',
      tenantId: MASTER_TENANT_ID,
    });
    await apiKeys.revoke(row.id);
    const token = await jwt.sign({ sub: 'sub-fallback', email: 'fallback@example.com' });

    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { 'x-api-key': secret, authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    // No user provisioned via the would-be JWT fallback.
    expect(await users.findBySupabaseId('sub-fallback')).toBeUndefined();
  });

  it('a garbage X-API-Key returns 401 and does NOT fall through to the Bearer token', async () => {
    const token = await jwt.sign({ sub: 'sub-garbage', email: 'garbage@example.com' });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { 'x-api-key': 'mrm_definitely-not-real', authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(await users.findBySupabaseId('sub-garbage')).toBeUndefined();
  });
});
