import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { OutboxRepository } from '../../src/repositories/outbox.js';
import { TenantsRepository } from '../../src/repositories/tenants.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

describe.skipIf(!(await isDbReachable()))('OutboxRepository', () => {
  let outbox: OutboxRepository;
  let tenants: TenantsRepository;

  beforeAll(() => {
    const { db } = getTestDb();
    outbox = new OutboxRepository(db);
    tenants = new TenantsRepository(db);
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('atomic enqueue: rolling back the outer tx also rolls back the outbox row', async () => {
    const { db } = getTestDb();
    await db
      .transaction(async (tx) => {
        await outbox.enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: MASTER_TENANT_ID,
          payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
        });
        throw new Error('boom');
      })
      .catch(() => undefined);

    const pending = await outbox.listPending();
    expect(pending).toHaveLength(0);
  });

  it('commits the outbox row atomically with a business write', async () => {
    const { db } = getTestDb();
    let createdTenantId = '';

    await db.transaction(async (tx) => {
      const created = await new TenantsRepository(tx).create({
        name: 'org-x',
        parentId: MASTER_TENANT_ID,
      });
      createdTenantId = created.id;
      await outbox.enqueue(tx, {
        aggregateType: 'tenant',
        aggregateId: created.id,
        payload: { kind: 'tenant.created', tenantId: created.id, parentId: MASTER_TENANT_ID },
      });
    });

    const pending = await outbox.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.aggregateId).toBe(createdTenantId);
    expect((pending[0]?.payload as { kind: string }).kind).toBe('tenant.created');

    expect(await tenants.get(createdTenantId)).toBeDefined();
  });

  it('claimBatch returns events, bumps attempts, and ackProcessed marks them done', async () => {
    const { db } = getTestDb();
    for (let i = 0; i < 3; i++) {
      await db.transaction(async (tx) => {
        await outbox.enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: MASTER_TENANT_ID,
          payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
        });
      });
    }

    const batch = await outbox.claimBatch(10);
    expect(batch).toHaveLength(3);
    expect(batch.every((e) => e.attempts === 1)).toBe(true);

    await outbox.ackProcessed(batch.map((e) => e.id));
    expect(await outbox.listPending()).toHaveLength(0);
  });

  it('recordFailure pushes the next retry forward and keeps the event pending', async () => {
    const { db } = getTestDb();
    await db.transaction(async (tx) => {
      await outbox.enqueue(tx, {
        aggregateType: 'tenant',
        aggregateId: MASTER_TENANT_ID,
        payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
      });
    });

    const [event] = await outbox.claimBatch(10);
    expect(event).toBeDefined();
    const future = new Date(Date.now() + 60_000);
    await outbox.recordFailure(event!.id, 'simulated failure', future);

    // Still unprocessed, but not yet eligible for claim
    const claimedAgain = await outbox.claimBatch(10);
    expect(claimedAgain).toHaveLength(0);
  });

  it('countPending / countDead / oldestPendingAt report queue depth', async () => {
    const { db } = getTestDb();
    expect(await outbox.countPending()).toBe(0);
    expect(await outbox.countDead()).toBe(0);
    expect(await outbox.oldestPendingAt()).toBeNull();

    for (let i = 0; i < 3; i++) {
      await db.transaction(async (tx) => {
        await outbox.enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: MASTER_TENANT_ID,
          payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
        });
      });
    }

    expect(await outbox.countPending()).toBe(3);
    expect(await outbox.countDead()).toBe(0);
    const oldest = await outbox.oldestPendingAt();
    expect(oldest).toBeInstanceOf(Date);

    // Dead-letter one event; pending drops by one, dead bumps to one.
    const batch = await outbox.claimBatch(10);
    await outbox.markDead(batch[0]!.id, 'too many tries');
    expect(await outbox.countPending()).toBe(2);
    expect(await outbox.countDead()).toBe(1);
  });
});
