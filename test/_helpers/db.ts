import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { seedSystemData } from '../../src/db/seeds/system.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://miramira:miramira@localhost:5432/miramira';

let _sql: postgres.Sql | undefined;
let _db: ReturnType<typeof drizzle> | undefined;

export function getTestDb(): { db: ReturnType<typeof drizzle>; sql: postgres.Sql } {
  if (!_db || !_sql) {
    _sql = postgres(DATABASE_URL, { max: 5, onnotice: () => undefined });
    _db = drizzle({ client: _sql });
  }
  return { db: _db, sql: _sql };
}

export async function closeTestDb(): Promise<void> {
  if (_sql) await _sql.end({ timeout: 5 });
  _sql = undefined;
  _db = undefined;
}

export async function isDbReachable(): Promise<boolean> {
  try {
    const { sql } = getTestDb();
    await sql`SELECT 1`;
    return true;
  } catch {
    await closeTestDb();
    return false;
  }
}

// Wipe ALL rows (including system seed) and re-apply the system seed using the
// same function that powers `npm run db:seed`. Keeps tests and bootstrap aligned.
export async function resetDb(): Promise<void> {
  const { db, sql } = getTestDb();
  await sql`
    TRUNCATE TABLE
      audit_log,
      role_bindings,
      role_scopes,
      principals,
      api_keys,
      outbox_events,
      users,
      roles,
      scopes,
      tenants
    RESTART IDENTITY CASCADE
  `;
  await seedSystemData(db);
}
