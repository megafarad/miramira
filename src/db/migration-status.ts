// Verifies that the database's `__drizzle_migrations` table reflects every
// migration shipped in this build. Used by /readyz to catch deploys where
// the migrator was skipped — e.g. the API container starts before the
// migration job has run.
//
// Strategy: the journal in src/db/migrations/meta/_journal.json is the
// source of truth for "what this build knows about". The applied count in
// `drizzle.__drizzle_migrations` is the source of truth for "what's on the
// database". If applied < expected, readyz fails until the migrator runs.
// Hash comparison is intentionally avoided — drizzle changes its hash
// algorithm between versions and would produce false-positive 503s.

import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

export interface MigrationCheckResult {
  healthy: boolean;
  latencyMs: number;
}

export interface MigrationStatusOptions {
  /** Expected count from the journal. Default loads from the shipped journal. */
  expectedCount?: number;
  /** Override for tests / alternate migration folders. */
  journalPath?: string;
}

/**
 * Read the migrations journal and return the number of entries. Called once
 * at startup; result is closed over by the check function so /readyz doesn't
 * re-read the file on every probe.
 */
export async function readJournalCount(
  journalPath = './src/db/migrations/meta/_journal.json',
): Promise<number> {
  const raw = await readFile(journalPath, 'utf8');
  const parsed = JSON.parse(raw) as { entries?: unknown[] };
  return parsed.entries?.length ?? 0;
}

/**
 * Build a /readyz check that compares the journal's expected migration count
 * against `drizzle.__drizzle_migrations`. Returns latency for the table query
 * so the readyz response shows per-check timings consistent with the others.
 */
export function buildMigrationsCheck(
  db: Database,
  opts: MigrationStatusOptions = {},
): () => Promise<MigrationCheckResult> {
  let expectedPromise: Promise<number> | null = null;
  const getExpected = (): Promise<number> => {
    if (opts.expectedCount !== undefined) return Promise.resolve(opts.expectedCount);
    expectedPromise ??= readJournalCount(opts.journalPath);
    return expectedPromise;
  };

  return async (): Promise<MigrationCheckResult> => {
    const start = Date.now();
    try {
      const expected = await getExpected();
      const rows = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations
      `);
      const applied = Number(rows[0]?.n ?? '0');
      return { healthy: applied >= expected, latencyMs: Date.now() - start };
    } catch {
      // Table missing or unreachable. Either way the system isn't ready for
      // traffic — a brand-new DB that hasn't been migrated also lands here.
      return { healthy: false, latencyMs: Date.now() - start };
    }
  };
}
