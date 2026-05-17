import type { OutboxRepo } from '../repositories/outbox.js';
import type { OutboxDispatcher } from './dispatcher.js';
import { DEFAULT_BACKOFF, nextRetryAt, type BackoffConfig } from '../lib/backoff.js';

export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface OutboxWorkerDeps {
  outbox: OutboxRepo;
  dispatcher: OutboxDispatcher;
  logger?: WorkerLogger;
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
}

export class OutboxWorker {
  private readonly batchSize: number;
  private readonly idlePollMs: number;
  private readonly backoff: BackoffConfig;
  private readonly logger: WorkerLogger | undefined;

  constructor(private readonly deps: OutboxWorkerDeps) {
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH;
    this.idlePollMs = deps.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.logger = deps.logger;
  }

  /**
   * Claim one batch and dispatch each event. Returns counts so callers
   * (tests, metrics) can observe what happened. Does NOT throw on per-event
   * failures — those are recorded as outbox retries.
   */
  async runOnce(): Promise<RunOnceResult> {
    const events = await this.deps.outbox.claimBatch(this.batchSize);
    if (events.length === 0) return { claimed: 0, acked: 0, failed: 0 };

    let acked = 0;
    let failed = 0;

    for (const evt of events) {
      try {
        await this.deps.dispatcher.handle(evt);
        await this.deps.outbox.ackProcessed([evt.id]);
        acked++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        // attempts was already bumped by claimBatch.
        const retryAt = nextRetryAt(evt.attempts, this.backoff);
        await this.deps.outbox.recordFailure(evt.id, msg, retryAt);
        this.logger?.warn(
          { eventId: evt.id, attempts: evt.attempts, retryAt, err: msg },
          'event delivery failed; scheduled for retry',
        );
      }
    }

    return { claimed: events.length, acked, failed };
  }

  /**
   * Run continuously until the AbortSignal fires. When the queue is empty,
   * sleeps `idlePollMs` before the next claim attempt. The signal short-
   * circuits the sleep on shutdown.
   */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const { claimed } = await this.runOnce();
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
