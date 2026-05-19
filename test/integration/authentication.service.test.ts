import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { createTestJwtContext, type TestJwtContext } from '../_helpers/fake-jwt.js';
import { ApiKeysRepository } from '../../src/repositories/api-keys.js';
import { AuditLogRepository } from '../../src/repositories/audit-log.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { UsersRepository } from '../../src/repositories/users.js';
import {
  AuthenticationServiceImpl,
  type AuthenticationService,
} from '../../src/services/authentication.js';
import { AuthError } from '../../src/services/errors.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';
import { auditLog as auditLogTable } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import type { AuditRequestContext } from '../../src/plugins/audit.js';

describe.skipIf(!(await isDbReachable()))('AuthenticationService (integration)', () => {
  let service: AuthenticationService;
  let users: UsersRepository;
  let apiKeys: ApiKeysRepository;
  let jwt: TestJwtContext;

  let warnings: { obj: Record<string, unknown>; msg: string }[];

  beforeAll(async () => {
    const { db } = getTestDb();
    users = new UsersRepository(db);
    apiKeys = new ApiKeysRepository(db);
    const principals = new PrincipalsRepository(db);
    jwt = await createTestJwtContext();
    warnings = [];
    service = new AuthenticationServiceImpl({
      users,
      apiKeys,
      principals,
      jwks: jwt.jwks,
      jwtIssuer: jwt.issuer,
      jwtAudience: jwt.audience,
      auditLog: new AuditLogRepository(db),
      logger: {
        warn: (obj, msg) => {
          warnings.push({ obj, msg });
        },
      },
    });
  });

  beforeEach(() => {
    warnings = [];
  });

  function fakeAudit(): AuditRequestContext {
    return {
      actorPrincipalId: null,
      actorKind: null,
      requestId: 'req-test',
      method: 'GET',
      route: '/test',
      ip: '127.0.0.1',
      userAgent: 'test',
    };
  }

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

  describe('email reconciliation', () => {
    it('no-ops when the JWT email matches the local row', async () => {
      const { db } = getTestDb();
      const u = await users.upsertByEmailId('static@example.com');
      await users.backfillSupabaseId(u.id, 'sub-static');

      const token = await jwt.sign({ sub: 'sub-static', email: 'static@example.com' });
      await service.authenticateJwt(token, fakeAudit());

      const refreshed = await users.findById(u.id);
      expect(refreshed?.email).toBe('static@example.com');
      const rows = await db.select().from(auditLogTable).where(eq(auditLogTable.targetId, u.id));
      expect(rows).toHaveLength(0);
    });

    it('updates email + writes a user.email_change audit row when JWT email differs', async () => {
      const { db } = getTestDb();
      const u = await users.upsertByEmailId('old@example.com');
      await users.backfillSupabaseId(u.id, 'sub-rotates');

      const token = await jwt.sign({ sub: 'sub-rotates', email: 'new@example.com' });
      await service.authenticateJwt(token, fakeAudit());

      const refreshed = await users.findById(u.id);
      expect(refreshed?.email).toBe('new@example.com');
      // Lookups by the new email succeed; old email no longer resolves.
      expect(await users.findByEmail('new@example.com')).toBeDefined();
      expect(await users.findByEmail('old@example.com')).toBeUndefined();

      const rows = await db.select().from(auditLogTable).where(eq(auditLogTable.targetId, u.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('user.email_change');
      expect(rows[0]?.before).toEqual({ email: 'old@example.com' });
      expect(rows[0]?.after).toEqual({ email: 'new@example.com' });
    });

    it('logs a warning and keeps the stale email when the new email already belongs to another user', async () => {
      const { db } = getTestDb();
      await users.upsertByEmailId('taken@example.com');
      const moving = await users.upsertByEmailId('moving@example.com');
      await users.backfillSupabaseId(moving.id, 'sub-moving');

      const token = await jwt.sign({ sub: 'sub-moving', email: 'taken@example.com' });
      const principal = await service.authenticateJwt(token, fakeAudit());

      // Auth still succeeded.
      expect(principal.userId).toBe(moving.id);
      const refreshed = await users.findById(moving.id);
      expect(refreshed?.email).toBe('moving@example.com');

      // No audit row, but a warning logged.
      const rows = await db
        .select()
        .from(auditLogTable)
        .where(eq(auditLogTable.targetId, moving.id));
      expect(rows).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.obj.userId).toBe(moving.id);
    });

    it('does not reconcile when the email differs only in case/whitespace', async () => {
      const { db } = getTestDb();
      const u = await users.upsertByEmailId('case@example.com');
      await users.backfillSupabaseId(u.id, 'sub-case');

      // Same canonical email (lowercased+trimmed), different raw spelling.
      const token = await jwt.sign({ sub: 'sub-case', email: '  Case@Example.com  ' });
      await service.authenticateJwt(token, fakeAudit());

      const rows = await db.select().from(auditLogTable).where(eq(auditLogTable.targetId, u.id));
      expect(rows).toHaveLength(0);
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
