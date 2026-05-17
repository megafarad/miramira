import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { RoleBindingsServiceImpl } from '../../src/services/role-bindings.js';
import { OutboxRepository } from '../../src/repositories/outbox.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { MASTER_TENANT_ID, SYSTEM_ROLE_ADMIN_ID } from '../../src/db/seeds/system-ids.js';
import { NotFoundError } from '../../src/services/errors.js';

describe.skipIf(!(await isDbReachable()))('RoleBindingsService', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  async function makeUserPrincipal(email: string): Promise<string> {
    const { db } = getTestDb();
    const u = await new UsersRepository(db).upsertByEmailId(email);
    const p = await new PrincipalsRepository(db).ensureForUser(u.id);
    return p.id;
  }

  it('create enqueues a role_binding.created event with the binding id', async () => {
    const { db } = getTestDb();
    const service = new RoleBindingsServiceImpl({ db });
    const principalId = await makeUserPrincipal('a@example.com');

    const row = await service.create({
      principalId,
      roleId: SYSTEM_ROLE_ADMIN_ID,
      tenantId: MASTER_TENANT_ID,
    });

    const pending = await new OutboxRepository(db).listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.eventType).toBe('role_binding.created');
    const payload = pending[0]?.payload as { kind: string; bindingId: string };
    expect(payload.bindingId).toBe(row.id);
  });

  it('revoke flips revoked_at and enqueues a role_binding.revoked event', async () => {
    const { db } = getTestDb();
    const service = new RoleBindingsServiceImpl({ db });
    const principalId = await makeUserPrincipal('b@example.com');
    const row = await service.create({
      principalId,
      roleId: SYSTEM_ROLE_ADMIN_ID,
      tenantId: MASTER_TENANT_ID,
    });

    const revoked = await service.revoke(row.id);
    expect(revoked.revokedAt).not.toBeNull();

    const pending = await new OutboxRepository(db).listPending();
    expect(pending.map((p) => p.eventType).sort()).toEqual([
      'role_binding.created',
      'role_binding.revoked',
    ]);
  });

  it('revoke on unknown id throws NotFoundError', async () => {
    const { db } = getTestDb();
    const service = new RoleBindingsServiceImpl({ db });
    await expect(service.revoke('00000000-0000-7000-8000-000000000000')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
