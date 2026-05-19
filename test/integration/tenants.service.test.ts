import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { TenantsServiceImpl } from '../../src/services/tenants.js';
import { TenantsRepository } from '../../src/repositories/tenants.js';
import { OutboxRepository } from '../../src/repositories/outbox.js';
import { ApiKeysRepository } from '../../src/repositories/api-keys.js';
import { RoleBindingsRepository } from '../../src/repositories/role-bindings.js';
import { RolesRepository } from '../../src/repositories/roles.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { ConflictError, NotFoundError } from '../../src/services/errors.js';
import { auditLog } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';
import type { AuditRequestContext } from '../../src/plugins/audit.js';

function fakeAudit(): AuditRequestContext {
  return {
    actorPrincipalId: null,
    actorKind: null,
    requestId: 'req-test',
    method: 'DELETE',
    route: '/tenants/:id',
    ip: '127.0.0.1',
    userAgent: 'test',
  };
}

describe.skipIf(!(await isDbReachable()))('TenantsService.create', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('creates the tenant row AND enqueues a tenant.created outbox event atomically', async () => {
    const { db } = getTestDb();
    const service = new TenantsServiceImpl({ db });

    const created = await service.create({ name: 'org-a', parentId: MASTER_TENANT_ID });
    expect(created.name).toBe('org-a');

    const tenants = new TenantsRepository(db);
    expect(await tenants.get(created.id)).toBeDefined();

    const outbox = new OutboxRepository(db);
    const pending = await outbox.listPending();
    const matching = pending.filter((e) => e.aggregateId === created.id);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.eventType).toBe('tenant.created');
    const payload = matching[0]?.payload as {
      kind: string;
      tenantId: string;
      parentId: string | null;
    };
    expect(payload.tenantId).toBe(created.id);
    expect(payload.parentId).toBe(MASTER_TENANT_ID);
  });

  it('rolls back BOTH the tenant row and the outbox event when the tx throws', async () => {
    const { db } = getTestDb();
    const tenants = new TenantsRepository(db);
    const outbox = new OutboxRepository(db);

    await db
      .transaction(async (tx) => {
        const txTenants = new TenantsRepository(tx);
        const txOutbox = new OutboxRepository(tx);
        const row = await txTenants.create({ name: 'will-rollback', parentId: MASTER_TENANT_ID });
        await txOutbox.enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: row.id,
          payload: { kind: 'tenant.created', tenantId: row.id, parentId: MASTER_TENANT_ID },
        });
        throw new Error('boom');
      })
      .catch(() => undefined);

    const all = await tenants.listChildren(MASTER_TENANT_ID);
    expect(all.find((t) => t.name === 'will-rollback')).toBeUndefined();
    const pending = await outbox.listPending();
    expect(pending).toHaveLength(0);
  });
});

describe.skipIf(!(await isDbReachable()))('TenantsService.delete', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('deletes a clean tenant and writes an audit row pinned to parentId', async () => {
    const { db } = getTestDb();
    const service = new TenantsServiceImpl({ db });
    const tenants = new TenantsRepository(db);

    const created = await service.create({ name: 'leaf', parentId: MASTER_TENANT_ID });
    await service.delete(created.id, fakeAudit());

    expect(await tenants.get(created.id)).toBeUndefined();
    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, created.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('tenant.delete');
    expect(audits[0]?.tenantId).toBe(MASTER_TENANT_ID);
    expect(audits[0]?.before).toBeTruthy();
    expect(audits[0]?.after).toBeNull();
  });

  it('rejects deleting the master tenant', async () => {
    const { db } = getTestDb();
    const service = new TenantsServiceImpl({ db });
    await expect(service.delete(MASTER_TENANT_ID)).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects when the tenant has child tenants', async () => {
    const { db } = getTestDb();
    const service = new TenantsServiceImpl({ db });
    const parent = await service.create({ name: 'parent', parentId: MASTER_TENANT_ID });
    await service.create({ name: 'child', parentId: parent.id });
    await expect(service.delete(parent.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.delete(parent.id)).rejects.toThrow(/child tenant/);
  });

  it('rejects when the tenant has api_keys (active or revoked)', async () => {
    const { db } = getTestDb();
    const service = new TenantsServiceImpl({ db });
    const apiKeys = new ApiKeysRepository(db);
    const tenant = await service.create({ name: 't', parentId: MASTER_TENANT_ID });

    const key = await apiKeys.create({ label: 'k', tenantId: tenant.id });
    await expect(service.delete(tenant.id)).rejects.toThrow(/api_key/);

    // Revoked keys still block.
    await apiKeys.revoke(key.row.id);
    await expect(service.delete(tenant.id)).rejects.toThrow(/api_key/);
  });

  it('rejects when the tenant has active role_bindings', async () => {
    const { db } = getTestDb();
    const service = new TenantsServiceImpl({ db });
    const users = new UsersRepository(db);
    const principals = new PrincipalsRepository(db);
    const rolesRepo = new RolesRepository(db);
    const bindings = new RoleBindingsRepository(db);

    const tenant = await service.create({ name: 't', parentId: MASTER_TENANT_ID });
    const user = await users.upsertByEmailId('blocker@x');
    const principal = await principals.ensureForUser(user.id);
    const role = await rolesRepo.create({ tenantId: tenant.id, name: 'r' });
    const binding = await bindings.create({
      principalId: principal.id,
      roleId: role.id,
      tenantId: tenant.id,
    });

    await expect(service.delete(tenant.id)).rejects.toThrow(/role_binding/);

    // Revoke and try again — now allowed.
    await bindings.revoke(binding.id);
    await service.delete(tenant.id, fakeAudit());
    expect(await new TenantsRepository(db).get(tenant.id)).toBeUndefined();
  });

  it('surfaces multiple blockers in a single error message', async () => {
    const { db } = getTestDb();
    const service = new TenantsServiceImpl({ db });
    const apiKeys = new ApiKeysRepository(db);
    const parent = await service.create({ name: 'multi', parentId: MASTER_TENANT_ID });
    await service.create({ name: 'child', parentId: parent.id });
    await apiKeys.create({ label: 'k', tenantId: parent.id });

    await expect(service.delete(parent.id)).rejects.toThrow(
      /child tenant.*api_key|api_key.*child tenant/,
    );
  });

  it('throws NotFoundError for an unknown tenant id', async () => {
    const { db } = getTestDb();
    const service = new TenantsServiceImpl({ db });
    await expect(service.delete('00000000-0000-7000-8000-000000000000')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
