import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { createTestFga, isFgaReachable } from '../_helpers/fga.js';
import { outboxEvents } from '../../src/db/schema.js';
import { OutboxRepository } from '../../src/repositories/outbox.js';
import { RoleBindingsServiceImpl } from '../../src/services/role-bindings.js';
import { RolesRepository } from '../../src/repositories/roles.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { OutboxDispatcherImpl } from '../../src/workers/dispatcher.js';
import { OutboxWorker } from '../../src/workers/worker.js';
import type { BackoffConfig } from '../../src/lib/backoff.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

// Backoff that retries fast and gives up after 3 failures — keeps the
// integration test under a second while still exercising the real DLQ logic.
const FAST_BACKOFF: BackoffConfig = {
  baseMs: 1,
  factor: 2,
  maxMs: 10,
  jitterRatio: 0,
  maxAttempts: 3,
};

describe.skipIf(!reachable)('OutboxWorker — dead-letter queue', () => {
  let cleanupFga: () => Promise<void>;
  let outbox: OutboxRepository;
  let bindings: RoleBindingsServiceImpl;
  let rolesRepo: RolesRepository;
  let users: UsersRepository;
  let principals: PrincipalsRepository;
  let angryWorker: OutboxWorker;

  beforeAll(async () => {
    const ctx = await createTestFga();
    cleanupFga = ctx.cleanup;
    const { db } = getTestDb();
    outbox = new OutboxRepository(db);
    bindings = new RoleBindingsServiceImpl({ db });
    rolesRepo = new RolesRepository(db);
    users = new UsersRepository(db);
    principals = new PrincipalsRepository(db);

    const angryMaterializer = {
      materializeBindingCreated: async (): Promise<void> => {
        throw new Error('poison event — always fails');
      },
      materializeBindingRevoked: async (): Promise<void> => undefined,
      materializeTenantCreated: async (): Promise<void> => undefined,
      materializeRoleScopeAdded: async (): Promise<void> => undefined,
      materializeRoleScopeRemoved: async (): Promise<void> => undefined,
    };
    angryWorker = new OutboxWorker({
      outbox,
      dispatcher: new OutboxDispatcherImpl({ materializer: angryMaterializer }),
      backoff: FAST_BACKOFF,
    });
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await cleanupFga();
    await closeTestDb();
  });

  async function seedPoisonEvent(): Promise<string> {
    const u = await users.upsertByEmailId('poison@example.com');
    const p = await principals.ensureForUser(u.id);
    const role = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'poison-role' });
    const binding = await bindings.create({
      principalId: p.id,
      roleId: role.id,
      tenantId: MASTER_TENANT_ID,
    });
    return binding.id;
  }

  // After each failed runOnce, the event's next_retry_at is bumped into the
  // future. To exercise multiple attempts in a tight loop without waiting
  // real time, we manually reset next_retry_at to now() between runs.
  async function makeEligibleAgain(): Promise<void> {
    const { db } = getTestDb();
    await db.update(outboxEvents).set({ nextRetryAt: sql`now()` });
  }

  it('marks an event dead after maxAttempts failures', async () => {
    await seedPoisonEvent();

    const r1 = await angryWorker.runOnce();
    expect(r1.failed).toBe(1);
    expect(r1.dead).toBe(0);

    await makeEligibleAgain();
    const r2 = await angryWorker.runOnce();
    expect(r2.failed).toBe(1);
    expect(r2.dead).toBe(0);

    await makeEligibleAgain();
    // Third attempt pushes attempts to 3 == maxAttempts, so this transitions
    // the event to dead.
    const r3 = await angryWorker.runOnce();
    expect(r3.dead).toBe(1);
    expect(r3.failed).toBe(0);

    const dead = await outbox.listDead();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.lastError).toContain('poison event');
    expect(dead[0]?.attempts).toBe(3);
  });

  it('dead events are not re-claimed', async () => {
    await seedPoisonEvent();
    for (let i = 0; i < 3; i++) {
      await angryWorker.runOnce();
      await makeEligibleAgain();
    }
    const dead = await outbox.listDead();
    expect(dead.length).toBeGreaterThan(0);

    // Even with next_retry_at = now(), claimBatch should skip dead rows.
    const r = await angryWorker.runOnce();
    expect(r.claimed).toBe(0);
  });

  it('manual revive (clear dead_at, reset attempts + next_retry_at) re-enables delivery', async () => {
    const bindingId = await seedPoisonEvent();
    for (let i = 0; i < 3; i++) {
      await angryWorker.runOnce();
      await makeEligibleAgain();
    }
    const deadBefore = await outbox.listDead();
    expect(deadBefore).toHaveLength(1);
    const deadEvent = deadBefore[0]!;

    // Operator's recovery procedure (documented in docs/observability.md):
    const { db } = getTestDb();
    await db
      .update(outboxEvents)
      .set({ deadAt: null, attempts: 0, lastError: null, nextRetryAt: sql`now()` })
      .where(eq(outboxEvents.id, deadEvent.id));

    // The angry worker would just re-poison it. The point of this test is
    // that the revived event re-enters the claim pool.
    const r = await angryWorker.runOnce();
    expect(r.claimed).toBe(1);
    // Use bindingId to silence the unused-var lint and document the link.
    expect(deadEvent.aggregateId).toBe(bindingId);
  });
});
