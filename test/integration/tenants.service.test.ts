import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { TenantsServiceImpl } from '../../src/services/tenants.js';
import { TenantsRepository } from '../../src/repositories/tenants.js';
import { OutboxRepository } from '../../src/repositories/outbox.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

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
    const payload = matching[0]?.payload as { kind: string; tenantId: string; parentId: string | null };
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
