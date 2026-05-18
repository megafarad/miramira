import { describe, expect, it } from 'vitest';
import { OutboxObserverImpl } from '../../src/services/outbox-observer.js';
import type { OutboxRepo, EnqueueInput } from '../../src/repositories/outbox.js';
import type { OutboxEvent } from '../../src/db/schema.js';
import type { DbOrTx } from '../../src/db/client.js';

function stubRepo(snapshot: { pending?: number; dead?: number; oldest?: Date | null }): OutboxRepo {
  return {
    enqueue: async (_tx: DbOrTx, _input: EnqueueInput) => ({}) as OutboxEvent,
    claimBatch: async () => [],
    ackProcessed: async () => undefined,
    recordFailure: async () => undefined,
    markDead: async () => undefined,
    listPending: async () => [],
    listDead: async () => [],
    countPending: async () => snapshot.pending ?? 0,
    countDead: async () => snapshot.dead ?? 0,
    oldestPendingAt: async () => snapshot.oldest ?? null,
    pageDead: async () => ({ items: [], nextCursor: null }),
    getDead: async () => null,
    revive: async () => null,
    purge: async () => null,
  };
}

describe('OutboxObserverImpl', () => {
  it('reports zero age when the queue is empty', async () => {
    const obs = new OutboxObserverImpl({
      outbox: stubRepo({ pending: 0, dead: 0, oldest: null }),
    });
    const snap = await obs.snapshot();
    expect(snap).toEqual({ pending: 0, dead: 0, oldestPendingAgeMs: 0 });
  });

  it('computes oldest age relative to provided now', async () => {
    const now = new Date('2026-05-18T12:00:00Z');
    const oldest = new Date('2026-05-18T11:59:30Z'); // 30s ago
    const obs = new OutboxObserverImpl({
      outbox: stubRepo({ pending: 4, dead: 1, oldest }),
    });
    const snap = await obs.snapshot(now);
    expect(snap.pending).toBe(4);
    expect(snap.dead).toBe(1);
    expect(snap.oldestPendingAgeMs).toBe(30_000);
  });

  it('clamps negative ages (future next_retry_at) to zero', async () => {
    const now = new Date('2026-05-18T12:00:00Z');
    const future = new Date('2026-05-18T12:01:00Z'); // 60s in the future
    const obs = new OutboxObserverImpl({
      outbox: stubRepo({ pending: 1, dead: 0, oldest: future }),
    });
    const snap = await obs.snapshot(now);
    expect(snap.oldestPendingAgeMs).toBe(0);
  });
});
