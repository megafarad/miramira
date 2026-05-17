import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { createTestJwtContext, type TestJwtContext } from '../_helpers/fake-jwt.js';
import { ApiKeysRepository } from '../../src/repositories/api-keys.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { UsersRepository } from '../../src/repositories/users.js';
import {
  AuthenticationServiceImpl,
  type AuthenticationService,
} from '../../src/services/authentication.js';
import { AuthError } from '../../src/services/errors.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

describe.skipIf(!(await isDbReachable()))('AuthenticationService (integration)', () => {
  let service: AuthenticationService;
  let users: UsersRepository;
  let apiKeys: ApiKeysRepository;
  let jwt: TestJwtContext;

  beforeAll(async () => {
    const { db } = getTestDb();
    users = new UsersRepository(db);
    apiKeys = new ApiKeysRepository(db);
    const principals = new PrincipalsRepository(db);
    jwt = await createTestJwtContext();
    service = new AuthenticationServiceImpl({
      users,
      apiKeys,
      principals,
      jwks: jwt.jwks,
      jwtIssuer: jwt.issuer,
      jwtAudience: jwt.audience,
    });
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe('JWT path', () => {
    it('returns the user principal when the user is found by sub', async () => {
      const u = await users.upsertByEmailId('alice@example.com');
      await users.backfillSupabaseId(u.id, 'sub-alice');

      const token = await jwt.sign({ sub: 'sub-alice', email: 'alice@example.com' });
      const principal = await service.authenticateJwt(token);

      expect(principal.kind).toBe('user');
      expect(principal.userId).toBe(u.id);
    });

    it('falls back to email lookup and backfills the sub', async () => {
      const u = await users.upsertByEmailId('bob@example.com'); // no sub yet

      const token = await jwt.sign({ sub: 'sub-bob', email: 'bob@example.com' });
      const principal = await service.authenticateJwt(token);

      expect(principal.userId).toBe(u.id);
      const refreshed = await users.findById(u.id);
      expect(refreshed?.supabaseUserId).toBe('sub-bob');
    });

    it('auto-provisions a user when neither sub nor email match an existing row', async () => {
      const token = await jwt.sign({ sub: 'sub-new', email: 'newcomer@example.com' });
      const principal = await service.authenticateJwt(token);

      expect(principal.kind).toBe('user');
      const u = await users.findById(principal.userId!);
      expect(u?.email).toBe('newcomer@example.com');
      expect(u?.supabaseUserId).toBe('sub-new');
    });

    it('rejects an expired token', async () => {
      const token = await jwt.sign({
        sub: 'sub-x',
        email: 'x@example.com',
        expiresIn: Math.floor(Date.now() / 1000) - 60,
      });
      await expect(service.authenticateJwt(token)).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a token with the wrong issuer', async () => {
      const token = await jwt.sign({
        sub: 'sub-x',
        email: 'x@example.com',
        issuer: 'https://other.example/auth',
      });
      await expect(service.authenticateJwt(token)).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a token with the wrong audience', async () => {
      const token = await jwt.sign({
        sub: 'sub-x',
        email: 'x@example.com',
        audience: 'other-aud',
      });
      await expect(service.authenticateJwt(token)).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a token with a bad signature', async () => {
      const token = await jwt.sign({ sub: 'sub-x', email: 'x@example.com' });
      const tampered = `${token.slice(0, -4)}AAAA`;
      await expect(service.authenticateJwt(tampered)).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects a token missing an email when no user exists', async () => {
      const token = await jwt.sign({ sub: 'sub-no-email' });
      await expect(service.authenticateJwt(token)).rejects.toBeInstanceOf(AuthError);
    });
  });

  describe('API key path', () => {
    it('returns an api_key principal for a valid key and touches last_used_at', async () => {
      const { secret, row } = await apiKeys.create({
        label: 'test',
        tenantId: MASTER_TENANT_ID,
      });

      const principal = await service.authenticateApiKey(secret);
      expect(principal.kind).toBe('api_key');
      expect(principal.apiKeyId).toBe(row.id);

      // touchLastUsed is fire-and-forget; allow it a moment to land.
      await new Promise((r) => setTimeout(r, 50));
      const refreshed = await apiKeys.findById(row.id);
      expect(refreshed?.lastUsedAt).not.toBeNull();
    });

    it('rejects a revoked key', async () => {
      const { secret, row } = await apiKeys.create({
        label: 'test',
        tenantId: MASTER_TENANT_ID,
      });
      await apiKeys.revoke(row.id);
      await expect(service.authenticateApiKey(secret)).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects an expired key', async () => {
      const { secret } = await apiKeys.create({
        label: 'test',
        tenantId: MASTER_TENANT_ID,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.authenticateApiKey(secret)).rejects.toBeInstanceOf(AuthError);
    });

    it('rejects an unknown secret', async () => {
      await expect(service.authenticateApiKey('mrm_nope')).rejects.toBeInstanceOf(AuthError);
    });
  });
});
