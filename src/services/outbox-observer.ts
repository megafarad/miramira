// Read-only view of the outbox for the metrics gauge collector.
//
// The dual-write rule says workers may not touch the repository layer
// directly; observability of the queue is still a worker concern, so it goes
// through this thin service. No writes here — the worker mutates outbox rows
// elsewhere via its existing repo handle.

import type { OutboxRepo } from '../repositories/outbox.js';

export interface OutboxQueueSnapshot {
  pending: number;
  dead: number;
  /** ms since the oldest pending event was eligible; 0 if the queue is empty. */
  oldestPendingAgeMs: number;
}

export interface OutboxObserver {
  snapshot(now?: Date): Promise<OutboxQueueSnapshot>;
}

export interface OutboxObserverDeps {
  outbox: OutboxRepo;
}

export class OutboxObserverImpl implements OutboxObserver {
  constructor(private readonly deps: OutboxObserverDeps) {}

  async snapshot(now: Date = new Date()): Promise<OutboxQueueSnapshot> {
    const [pending, dead, oldest] = await Promise.all([
      this.deps.outbox.countPending(),
      this.deps.outbox.countDead(),
      this.deps.outbox.oldestPendingAt(),
    ]);
    // next_retry_at can be in the future for retried events, in which case
    // the "age" is negative — clamp to 0 so the gauge never reports a
    // nonsensical lag for a queue that's caught up.
    const ageMs = oldest === null ? 0 : Math.max(0, now.getTime() - oldest.getTime());
    return { pending, dead, oldestPendingAgeMs: ageMs };
  }
}
