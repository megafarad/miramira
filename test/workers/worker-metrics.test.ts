import { describe, expect, it } from 'vitest';
import { OutboxWorker } from '../../src/workers/worker.js';
import { createMetricsRegistry } from '../../src/lib/metrics.js';
import type { OutboxRepo, EnqueueInput } from '../../src/repositories/outbox.js';
import type { OutboxDispatcher } from '../../src/workers/dispatcher.js';
import type { OutboxEvent } from '../../src/db/schema.js';
import type { DbOrTx } from '../../src/db/client.js';

function event(id: string): OutboxEvent {
  return {
    id,
    aggregateType: 'tenant',
    aggregateId: '00000000-0000-7000-8000-000000000001',
    eventType: 'tenant.created',
    payload: { kind: 'tenant.created', tenantId: 't1', parentId: null },
    createdAt: new Date(),
    processedAt: null,
    attempts: 1,
    lastError: null,
    nextRetryAt: new Date(),
    deadAt: null,
    updatedAt: new Date(),
  };
}

function stubRepo(events: OutboxEvent[]): OutboxRepo {
  let claimed = false;
  return {
    enqueue: async (_tx: DbOrTx, _input: EnqueueInput) => events[0]!,
    claimBatch: async () => {
      if (claimed) return [];
      claimed = true;
      return events;
    },
    ackProcessed: async () => undefined,
    recordFailure: async () => undefined,
    markDead: async () => undefined,
    listPending: async () => [],
    listDead: async () => [],
    countPending: async () => 0,
    countDead: async () => 0,
    oldestPendingAt: async () => null,
    pageDead: async () => ({ items: [], nextCursor: null }),
    getDead: async () => null,
    countDeadMatching: async () => 0,
    findDeadIdsMatching: async () => [],
    revive: async () => null,
    purge: async () => null,
    reviveBulk: async () => [],
    purgeBulk: async () => [],
  };
}

describe('OutboxWorker metrics emission', () => {
  it('increments claimed/acked counters and observes batch duration on success', async () => {
    const metrics = createMetricsRegistry();
    const dispatcher: OutboxDispatcher = { handle: async () => undefined };
    const worker = new OutboxWorker({
      outbox: stubRepo([event('e1'), event('e2')]),
      dispatcher,
      metrics,
    });

    const res = await worker.runOnce();
    expect(res).toEqual({ claimed: 2, acked: 2, failed: 0, dead: 0, abandoned: 0 });

    const text = await metrics.registry.metrics();
    expect(text).toContain('outbox_batch_claimed_total 2');
    expect(text).toContain('outbox_events_acked_total 2');
    expect(text).toMatch(/outbox_batch_duration_ms_count 1/);
  });

  it('increments failed counter when dispatcher throws below maxAttempts', async () => {
    const metrics = createMetricsRegistry();
    const dispatcher: OutboxDispatcher = {
      handle: async () => {
        throw new Error('transient');
      },
    };
    const worker = new OutboxWorker({
      outbox: stubRepo([event('e1')]),
      dispatcher,
      metrics,
    });

    await worker.runOnce();
    const text = await metrics.registry.metrics();
    expect(text).toContain('outbox_events_failed_total 1');
    expect(text).toContain('outbox_events_dead_total 0');
  });

  it('does not increment anything when no events are claimed', async () => {
    const metrics = createMetricsRegistry();
    const empty: OutboxRepo = { ...stubRepo([]), claimBatch: async () => [] };
    const worker = new OutboxWorker({
      outbox: empty,
      dispatcher: { handle: async () => undefined },
      metrics,
    });

    await worker.runOnce();
    const text = await metrics.registry.metrics();
    expect(text).toContain('outbox_batch_claimed_total 0');
    // No batch duration sample on an empty claim.
    expect(text).toMatch(/outbox_batch_duration_ms_count 0/);
  });
});
