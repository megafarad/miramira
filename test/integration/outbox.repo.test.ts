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

  it('pageDead returns rows newest first and walks via cursor', async () => {
    const { db } = getTestDb();
    const deadIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const evt = await db.transaction(async (tx) =>
        outbox.enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: MASTER_TENANT_ID,
          payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
        }),
      );
      await outbox.markDead(evt.id, `boom-${i}`);
      deadIds.push(evt.id);
    }

    // Newest first: UUIDv7 means the last-inserted id sorts highest.
    const first = await outbox.pageDead({ limit: 2 });
    expect(first.items.map((r) => r.id)).toEqual([deadIds[4], deadIds[3]]);
    expect(first.nextCursor).toBe(deadIds[3]);

    const second = await outbox.pageDead({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((r) => r.id)).toEqual([deadIds[2], deadIds[1]]);
    expect(second.nextCursor).toBe(deadIds[1]);

    const third = await outbox.pageDead({ limit: 2, cursor: second.nextCursor! });
    expect(third.items.map((r) => r.id)).toEqual([deadIds[0]]);
    expect(third.nextCursor).toBeNull();
  });

  it('getDead returns the row when dead, null otherwise', async () => {
    const { db } = getTestDb();
    const live = await db.transaction(async (tx) =>
      outbox.enqueue(tx, {
        aggregateType: 'tenant',
        aggregateId: MASTER_TENANT_ID,
        payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
      }),
    );
    // Not yet dead — must return null even though the id exists.
    expect(await outbox.getDead(live.id)).toBeNull();
    await outbox.markDead(live.id, 'permanent failure');
    const row = await outbox.getDead(live.id);
    expect(row?.id).toBe(live.id);
    expect(row?.deadAt).toBeInstanceOf(Date);

    // Unknown id returns null.
    expect(await outbox.getDead('00000000-0000-7000-8000-000000000000')).toBeNull();
  });

  it('revive clears dead_at, resets attempts/error, and makes the event claimable', async () => {
    const { db } = getTestDb();
    const evt = await db.transaction(async (tx) =>
      outbox.enqueue(tx, {
        aggregateType: 'tenant',
        aggregateId: MASTER_TENANT_ID,
        payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
      }),
    );
    await outbox.markDead(evt.id, 'gave up');

    const revived = await outbox.revive(evt.id);
    expect(revived?.deadAt).toBeNull();
    expect(revived?.attempts).toBe(0);
    expect(revived?.lastError).toBeNull();

    // claimBatch can now pick it up again.
    const claimed = await outbox.claimBatch(10);
    expect(claimed.map((r) => r.id)).toContain(evt.id);
  });

  it('revive returns null for a non-dead event (no accidental restart)', async () => {
    const { db } = getTestDb();
    const evt = await db.transaction(async (tx) =>
      outbox.enqueue(tx, {
        aggregateType: 'tenant',
        aggregateId: MASTER_TENANT_ID,
        payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
      }),
    );
    const out = await outbox.revive(evt.id);
    expect(out).toBeNull();
  });

  it('purge deletes a dead row and returns it; refuses non-dead rows', async () => {
    const { db } = getTestDb();
    const live = await db.transaction(async (tx) =>
      outbox.enqueue(tx, {
        aggregateType: 'tenant',
        aggregateId: MASTER_TENANT_ID,
        payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
      }),
    );
    // Live event is not deletable via purge.
    expect(await outbox.purge(live.id)).toBeNull();

    await outbox.markDead(live.id, 'final');
    const deleted = await outbox.purge(live.id);
    expect(deleted?.id).toBe(live.id);

    // Subsequent purge call finds nothing.
    expect(await outbox.purge(live.id)).toBeNull();
    expect(await outbox.getDead(live.id)).toBeNull();
  });

  it('pageDead, countDeadMatching, findDeadIdsMatching honor eventType + deadBefore filters', async () => {
    const { db } = getTestDb();
    // Two event types so filtering on eventType has something to discriminate.
    const tenantIds: string[] = [];
    const bindingIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await db.transaction(async (tx) =>
        outbox.enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: MASTER_TENANT_ID,
          payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
        }),
      );
      await outbox.markDead(e.id, 't');
      tenantIds.push(e.id);
    }
    for (let i = 0; i < 2; i++) {
      const e = await db.transaction(async (tx) =>
        outbox.enqueue(tx, {
          aggregateType: 'role_binding',
          aggregateId: MASTER_TENANT_ID,
          payload: { kind: 'role_binding.revoked', bindingId: 'b' },
        }),
      );
      await outbox.markDead(e.id, 'rb');
      bindingIds.push(e.id);
    }

    expect(await outbox.countDeadMatching({})).toBe(5);
    expect(await outbox.countDeadMatching({ eventType: 'tenant.created' })).toBe(3);
    expect(await outbox.countDeadMatching({ eventType: 'role_binding.revoked' })).toBe(2);

    const tenantOnly = await outbox.pageDead({ limit: 10, eventType: 'tenant.created' });
    expect(tenantOnly.items.map((r) => r.id).sort()).toEqual([...tenantIds].sort());

    const ids = await outbox.findDeadIdsMatching({ eventType: 'role_binding.revoked' }, 10);
    expect(ids.sort()).toEqual([...bindingIds].sort());

    // deadBefore filter: everything is dead "now-ish", so a future cutoff
    // matches all; a past cutoff matches none.
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60 * 60_000);
    expect(await outbox.countDeadMatching({ deadBefore: future })).toBe(5);
    expect(await outbox.countDeadMatching({ deadBefore: past })).toBe(0);
  });

  it('reviveBulk revives dead rows and silently skips non-dead ids', async () => {
    const { db } = getTestDb();
    const deadIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await db.transaction(async (tx) =>
        outbox.enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: MASTER_TENANT_ID,
          payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
        }),
      );
      await outbox.markDead(e.id, 'boom');
      deadIds.push(e.id);
    }
    // Add one live (non-dead) event so we can verify the guard skips it.
    const live = await db.transaction(async (tx) =>
      outbox.enqueue(tx, {
        aggregateType: 'tenant',
        aggregateId: MASTER_TENANT_ID,
        payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
      }),
    );

    const revived = await outbox.reviveBulk([...deadIds, live.id]);
    expect(revived.map((r) => r.id).sort()).toEqual([...deadIds].sort());
    for (const row of revived) {
      expect(row.deadAt).toBeNull();
      expect(row.attempts).toBe(0);
      expect(row.lastError).toBeNull();
    }
    // Empty input is a no-op, not an error.
    expect(await outbox.reviveBulk([])).toEqual([]);
  });

  it('purgeBulk deletes dead rows and silently skips non-dead ids', async () => {
    const { db } = getTestDb();
    const deadIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await db.transaction(async (tx) =>
        outbox.enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: MASTER_TENANT_ID,
          payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
        }),
      );
      await outbox.markDead(e.id, 'boom');
      deadIds.push(e.id);
    }
    const live = await db.transaction(async (tx) =>
      outbox.enqueue(tx, {
        aggregateType: 'tenant',
        aggregateId: MASTER_TENANT_ID,
        payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
      }),
    );

    const deleted = await outbox.purgeBulk([...deadIds, live.id]);
    expect(deleted.map((r) => r.id).sort()).toEqual([...deadIds].sort());
    expect(await outbox.countDead()).toBe(0);
    // Live event still around — it wasn't dead, so the guard skipped it.
    expect(await outbox.listPending()).toHaveLength(1);
    expect(await outbox.purgeBulk([])).toEqual([]);
  });
});
