import type { OutboxRepo } from '../repositories/outbox.js';
import type { OutboxDispatcher } from './dispatcher.js';
import {
  DEFAULT_BACKOFF,
  nextRetryAt,
  shouldMarkDead,
  type BackoffConfig,
} from '../lib/backoff.js';
import type { Metrics } from '../lib/metrics.js';

export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// Subset of the Metrics bundle the worker actually emits — keeps the dep
// surface minimal for tests that build a partial registry.
export type WorkerMetrics = Pick<
  Metrics,
  | 'outboxBatchClaimedTotal'
  | 'outboxEventsAckedTotal'
  | 'outboxEventsFailedTotal'
  | 'outboxEventsDeadTotal'
  | 'outboxBatchDurationMs'
>;

export interface OutboxWorkerDeps {
  outbox: OutboxRepo;
  dispatcher: OutboxDispatcher;
  logger?: WorkerLogger;
  metrics?: WorkerMetrics;
  backoff?: BackoffConfig;
  batchSize?: number;
  idlePollMs?: number;
}

const DEFAULT_BATCH = 25;
const DEFAULT_IDLE_POLL_MS = 500;

export interface RunOnceResult {
  claimed: number;
  acked: number;
  failed: number;
  /** Events that crossed maxAttempts this run and were sent to the DLQ. */
  dead: number;
  /** Events that we stopped iterating over mid-batch due to a shutdown signal. */
  abandoned: number;
}

export class OutboxWorker {
  private readonly batchSize: number;
  private readonly idlePollMs: number;
  private readonly backoff: BackoffConfig;
  private readonly logger: WorkerLogger | undefined;
  private readonly metrics: WorkerMetrics | undefined;

  constructor(private readonly deps: OutboxWorkerDeps) {
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH;
    this.idlePollMs = deps.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
  }

  /**
   * Claim one batch and dispatch each event. Returns counts so callers
   * (tests, metrics) can observe what happened. Does NOT throw on per-event
   * failures — those are recorded as outbox retries or dead-lettered when
   * they exceed maxAttempts. Honours an optional AbortSignal so a shutdown
   * signal stops iteration after the in-flight event finishes.
   */
  async runOnce(signal?: AbortSignal): Promise<RunOnceResult> {
    const batchStart = Date.now();
    const events = await this.deps.outbox.claimBatch(this.batchSize);
    if (events.length === 0) {
      return { claimed: 0, acked: 0, failed: 0, dead: 0, abandoned: 0 };
    }

    let acked = 0;
    let failed = 0;
    let dead = 0;
    let abandoned = 0;

    for (const evt of events) {
      try {
        await this.deps.dispatcher.handle(evt);
        await this.deps.outbox.ackProcessed([evt.id]);
        acked++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // attempts was already bumped by claimBatch.
        if (shouldMarkDead(evt.attempts, this.backoff)) {
          await this.deps.outbox.markDead(evt.id, msg);
          dead++;
          this.logger?.error(
            {
              eventId: evt.id,
              attempts: evt.attempts,
              eventType: evt.eventType,
              aggregateType: evt.aggregateType,
              aggregateId: evt.aggregateId,
              payload: evt.payload,
              err: msg,
            },
            'event delivery permanently failed; moved to dead-letter',
          );
        } else {
          failed++;
          const retryAt = nextRetryAt(evt.attempts, this.backoff);
          await this.deps.outbox.recordFailure(evt.id, msg, retryAt);
          this.logger?.warn(
            { eventId: evt.id, attempts: evt.attempts, retryAt, err: msg },
            'event delivery failed; scheduled for retry',
          );
        }
      }
      // Shutdown requested mid-batch: finish the in-flight event but don't
      // pick up the next one. Remaining claimed events keep their bumped
      // attempts count and become eligible on next runOnce after their
      // next_retry_at (which is unchanged from before claim).
      if (signal?.aborted) {
        abandoned = events.length - (acked + failed + dead);
        break;
      }
    }

    if (this.metrics) {
      this.metrics.outboxBatchClaimedTotal.inc(events.length);
      if (acked) this.metrics.outboxEventsAckedTotal.inc(acked);
      if (failed) this.metrics.outboxEventsFailedTotal.inc(failed);
      if (dead) this.metrics.outboxEventsDeadTotal.inc(dead);
      this.metrics.outboxBatchDurationMs.observe(Date.now() - batchStart);
    }

    return { claimed: events.length, acked, failed, dead, abandoned };
  }

  /**
   * Run continuously until the AbortSignal fires. When the queue is empty,
   * sleeps `idlePollMs` before the next claim attempt. The signal short-
   * circuits the sleep on shutdown.
   */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const { claimed } = await this.runOnce(signal);
        if (claimed === 0) await waitOrAbort(this.idlePollMs, signal);
      } catch (err) {
        // Failure of the claim/loop itself (e.g. DB connection lost). Pause
        // and retry — don't crash the worker process.
        this.logger?.error({ err }, 'worker loop iteration failed');
        await waitOrAbort(this.idlePollMs, signal);
      }
    }
  }
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
