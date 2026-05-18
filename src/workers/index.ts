// Outbox worker entrypoint (`npm run worker`).
//
// Wires env, DB, FGA client, and services together, then runs the OutboxWorker
// loop until SIGINT/SIGTERM. Per dual-write.md, the dispatcher only routes to
// service-layer code — no direct Drizzle or @openfga/sdk calls here.

import { loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import { createFgaClient } from '../openfga/client.js';
import { MetricsFgaClient } from '../openfga/metrics-client.js';
import { createMetricsRegistry } from '../lib/metrics.js';
import { OutboxRepository } from '../repositories/outbox.js';
import { GrantMaterializerImpl } from '../services/grant-materializer.js';
import { OutboxObserverImpl } from '../services/outbox-observer.js';
import { OutboxDispatcherImpl } from './dispatcher.js';
import { OutboxWorker } from './worker.js';
import { startWorkerMetricsServer } from './metrics-server.js';
import { withShutdownTimeout } from '../lib/shutdown.js';

// How often to refresh queue-depth gauges. Tight enough that alerts fire
// within a minute of a backlog forming; loose enough that the COUNT queries
// are inconsequential even with hundreds of workers.
const GAUGE_INTERVAL_MS = 15_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, sql } = createDb(env);
  const metrics = createMetricsRegistry();
  const fga = new MetricsFgaClient(
    createFgaClient({
      apiUrl: env.OPENFGA_API_URL,
      storeId: env.OPENFGA_STORE_ID,
      authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID,
    }),
    metrics,
  );

  const outbox = new OutboxRepository(db);
  const observer = new OutboxObserverImpl({ outbox });
  const materializer = new GrantMaterializerImpl({ db, fga });
  const logger = {
    info: (obj: Record<string, unknown>, msg: string): void => {
      console.log(JSON.stringify({ level: 'info', msg, ...obj }));
    },
    warn: (obj: Record<string, unknown>, msg: string): void => {
      console.warn(JSON.stringify({ level: 'warn', msg, ...obj }));
    },
    error: (obj: Record<string, unknown>, msg: string): void => {
      console.error(JSON.stringify({ level: 'error', msg, ...obj }));
    },
  };
  const dispatcher = new OutboxDispatcherImpl({ materializer, logger });
  const worker = new OutboxWorker({ outbox, dispatcher, logger, metrics });

  const metricsServer = await startWorkerMetricsServer({
    metrics,
    host: env.HOST,
    port: env.METRICS_PORT,
    logger,
  });

  // Periodically refresh queue-depth gauges. setInterval is fine — the
  // snapshot is fast (COUNT against partial indexes) and we don't need
  // sub-second precision here.
  const gaugeTimer = setInterval(() => {
    void (async (): Promise<void> => {
      try {
        const snap = await observer.snapshot();
        metrics.outboxPending.set(snap.pending);
        metrics.outboxDead.set(snap.dead);
        metrics.outboxOldestPendingAgeMs.set(snap.oldestPendingAgeMs);
      } catch (err) {
        logger.error({ err: String(err) }, 'outbox gauge collection failed');
      }
    })();
  }, GAUGE_INTERVAL_MS);
  // Don't keep the process alive solely for the gauge timer.
  gaugeTimer.unref();

  const controller = new AbortController();
  let shuttingDown = false;
  // Fires when shutdown is requested so we can wrap the drain in a watchdog.
  let onShutdown: () => void = () => undefined;
  const shutdownRequested = new Promise<void>((resolve) => {
    onShutdown = resolve;
  });
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'worker shutdown signal received');
    controller.abort();
    onShutdown();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info({}, 'worker started');
  const runPromise = worker.run(controller.signal);
  await shutdownRequested;
  // Drain: wait for the current batch (and DB pool) to finish, with a hard
  // ceiling so a hung dispatcher call doesn't outlive the grace period.
  await withShutdownTimeout(
    (async () => {
      clearInterval(gaugeTimer);
      await runPromise;
      await metricsServer.close();
      await sql.end({ timeout: 5 });
    })(),
    env.SHUTDOWN_TIMEOUT_MS,
    logger,
    'outbox worker',
  );
  logger.info({}, 'worker stopped');
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: 'worker crashed', err: String(err) }));
  process.exit(1);
});
