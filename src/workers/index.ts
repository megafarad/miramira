// Outbox worker entrypoint (`npm run worker`).
//
// Wires env, DB, FGA client, and services together, then runs the OutboxWorker
// loop until SIGINT/SIGTERM. Per dual-write.md, the dispatcher only routes to
// service-layer code — no direct Drizzle or @openfga/sdk calls here.

import { loadEnv } from '../config/env.js';
import { createDb } from '../db/client.js';
import { createFgaClient } from '../openfga/client.js';
import { OutboxRepository } from '../repositories/outbox.js';
import { GrantMaterializerImpl } from '../services/grant-materializer.js';
import { OutboxDispatcherImpl } from './dispatcher.js';
import { OutboxWorker } from './worker.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, sql } = createDb(env);
  const fga = createFgaClient({
    apiUrl: env.OPENFGA_API_URL,
    storeId: env.OPENFGA_STORE_ID,
    authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID,
  });

  const outbox = new OutboxRepository(db);
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
  const worker = new OutboxWorker({ outbox, dispatcher, logger });

  const controller = new AbortController();
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'worker shutdown signal received');
    controller.abort();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info({}, 'worker started');
  await worker.run(controller.signal);
  await sql.end({ timeout: 5 });
  logger.info({}, 'worker stopped');
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: 'worker crashed', err: String(err) }));
  process.exit(1);
});
