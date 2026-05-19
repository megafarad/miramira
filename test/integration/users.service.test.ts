import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { UsersServiceImpl, REVOKE_ALL_BINDINGS_CAP } from '../../src/services/users.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { RolesRepository } from '../../src/repositories/roles.js';
import { RoleBindingsRepository } from '../../src/repositories/role-bindings.js';
import { ConflictError, NotFoundError } from '../../src/services/errors.js';
import { auditLog, outboxEvents } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';
import type { AuditRequestContext } from '../../src/plugins/audit.js';

function fakeAudit(method = 'POST', route = '/users/:id'): AuditRequestContext {
  return {
    actorPrincipalId: null,
    actorKind: null,
    requestId: 'req-test',
    method,
    route,
    ip: '127.0.0.1',
    userAgent: 'test',
  };
}

describe.skipIf(!(await isDbReachable()))('UsersService', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  describe('disable', () => {
    it('sets disabled_at and writes a user.disable audit row', async () => {
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const service = new UsersServiceImpl({ db });

      const u = await users.upsertByEmailId('a@x');
      const after = await service.disable(u.id, fakeAudit());
      expect(after.disabledAt).not.toBeNull();

      const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, u.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('user.disable');
    });

    it('is a no-op on a second call: returns the row but writes no audit', async () => {
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const service = new UsersServiceImpl({ db });

      const u = await users.upsertByEmailId('b@x');
      await service.disable(u.id, fakeAudit());
      await service.disable(u.id, fakeAudit());

      const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, u.id));
      expect(rows).toHaveLength(1);
    });

    it('rejects on an already-deleted user', async () => {
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const service = new UsersServiceImpl({ db });

      const u = await users.upsertByEmailId('c@x');
      await users.softDelete(u.id);
      await expect(service.disable(u.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it('404s on unknown id', async () => {
      const { db } = getTestDb();
      const service = new UsersServiceImpl({ db });
      await expect(service.disable('00000000-0000-7000-8000-000000000000')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('enable', () => {
    it('clears disabled_at and writes a user.enable audit row', async () => {
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const service = new UsersServiceImpl({ db });

      const u = await users.upsertByEmailId('d@x');
      await service.disable(u.id, fakeAudit());
      const after = await service.enable(u.id, fakeAudit());
      expect(after.disabledAt).toBeNull();

      const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, u.id));
      // disable + enable, no extra rows from no-op calls.
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.action).sort()).toEqual(['user.disable', 'user.enable']);
    });

    it('is a no-op on an already-enabled user', async () => {
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const service = new UsersServiceImpl({ db });

      const u = await users.upsertByEmailId('e@x');
      await service.enable(u.id, fakeAudit());

      const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, u.id));
      expect(rows).toHaveLength(0);
    });
  });

  describe('revokeAllBindings', () => {
    it('revokes every active binding and enqueues one outbox event per binding', async () => {
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const principals = new PrincipalsRepository(db);
      const rolesRepo = new RolesRepository(db);
      const bindings = new RoleBindingsRepository(db);
      const service = new UsersServiceImpl({ db });

      const u = await users.upsertByEmailId('owner@x');
      const principal = await principals.ensureForUser(u.id);
      const r1 = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'r1' });
      const r2 = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'r2' });
      const b1 = await bindings.create({
        principalId: principal.id,
        roleId: r1.id,
        tenantId: MASTER_TENANT_ID,
      });
      const b2 = await bindings.create({
        principalId: principal.id,
        roleId: r2.id,
        tenantId: MASTER_TENANT_ID,
      });

      const result = await service.revokeAllBindings(u.id, fakeAudit());
      expect(result.revoked).toBe(2);
      expect(new Set(result.bindingIds)).toEqual(new Set([b1.id, b2.id]));

      // Both bindings now revoked.
      expect((await bindings.findById(b1.id))?.revokedAt).not.toBeNull();
      expect((await bindings.findById(b2.id))?.revokedAt).not.toBeNull();

      // One outbox event per revoked binding.
      const events = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateType, 'role_binding'));
      const revokedEvents = events.filter(
        (e) => (e.payload as { kind: string }).kind === 'role_binding.revoked',
      );
      expect(revokedEvents).toHaveLength(2);

      // Single summary audit row.
      const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, u.id));
      const revoke = rows.filter((r) => r.action === 'user.bindings_revoke_all');
      expect(revoke).toHaveLength(1);
      expect(revoke[0]?.before).toEqual({ revokedCount: 2 });
    });

    it('returns 0 when the user has no principal or no active bindings', async () => {
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const service = new UsersServiceImpl({ db });

      const u = await users.upsertByEmailId('lonely@x');
      const result = await service.revokeAllBindings(u.id, fakeAudit());
      expect(result.revoked).toBe(0);
      expect(result.bindingIds).toEqual([]);

      // No audit row when nothing happened.
      const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, u.id));
      expect(rows).toHaveLength(0);
    });

    it('refuses with ConflictError when active count exceeds the cap', async () => {
      // Cheaper than inserting 501 real bindings — stub a service whose
      // bindings repo reports a count above the cap.
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const principals = new PrincipalsRepository(db);
      const u = await users.upsertByEmailId('busy@x');
      await principals.ensureForUser(u.id);

      const service = new UsersServiceImpl({ db });
      // vi.spyOn the prototype so the service's internally-instantiated repo
      // sees the stub. Cheaper than inserting 501 real bindings; the
      // teardown is automatic via mockRestore.
      const spy = vi
        .spyOn(RoleBindingsRepository.prototype, 'countActiveForPrincipal')
        .mockResolvedValue(REVOKE_ALL_BINDINGS_CAP + 1);
      try {
        await expect(service.revokeAllBindings(u.id)).rejects.toBeInstanceOf(ConflictError);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('delete', () => {
    it('soft-deletes a user with no active bindings and writes audit', async () => {
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const service = new UsersServiceImpl({ db });

      const u = await users.upsertByEmailId('gone@x');
      await service.delete(u.id, fakeAudit('DELETE'));

      const after = await users.findByIdIncludingDeleted(u.id);
      expect(after?.deletedAt).not.toBeNull();
      expect(after?.supabaseUserId).toBeNull();

      const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, u.id));
      const del = rows.filter((r) => r.action === 'user.delete');
      expect(del).toHaveLength(1);
    });

    it('refuses with ConflictError when the user has active bindings', async () => {
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const principals = new PrincipalsRepository(db);
      const rolesRepo = new RolesRepository(db);
      const bindings = new RoleBindingsRepository(db);
      const service = new UsersServiceImpl({ db });

      const u = await users.upsertByEmailId('held@x');
      const principal = await principals.ensureForUser(u.id);
      const role = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'rr' });
      await bindings.create({
        principalId: principal.id,
        roleId: role.id,
        tenantId: MASTER_TENANT_ID,
      });

      await expect(service.delete(u.id)).rejects.toBeInstanceOf(ConflictError);
      await expect(service.delete(u.id)).rejects.toThrow(/role_binding/);

      // After revoke-all, delete succeeds.
      await service.revokeAllBindings(u.id);
      await service.delete(u.id, fakeAudit('DELETE'));
      expect((await users.findByIdIncludingDeleted(u.id))?.deletedAt).not.toBeNull();
    });

    it('404s on a double-delete (already soft-deleted)', async () => {
      const { db } = getTestDb();
      const users = new UsersRepository(db);
      const service = new UsersServiceImpl({ db });

      const u = await users.upsertByEmailId('twice@x');
      await service.delete(u.id, fakeAudit('DELETE'));
      await expect(service.delete(u.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
