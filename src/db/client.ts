import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from '../config/env.js';

export type Database = ReturnType<typeof drizzle>;

// Either a top-level Database or a transaction handle. Derived from the
// transaction callback's first parameter so we don't have to keep up with
// drizzle's transaction generic signature (which changed between 0.x and 1.0).
export type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbHandles {
  db: Database;
  sql: postgres.Sql;
}

export function createDb(env: Env): DbHandles {
  const sql = postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === 'production' ? 20 : 5,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  // drizzle-orm 1.0 requires the postgres client via a config object.
  const db = drizzle({ client: sql });
  return { db, sql };
}
