// Unit tests for the journal-count helper and the buildMigrationsCheck
// behaviour around DB errors. The integration of an actually-applied
// migration count is exercised by the live /readyz against the test DB.

import { describe, expect, it } from 'vitest';
import { readJournalCount, buildMigrationsCheck } from '../../src/db/migration-status.js';
import type { Database } from '../../src/db/client.js';

describe('readJournalCount', () => {
  it('returns the number of entries in the shipped journal', async () => {
    const n = await readJournalCount();
    // Three migrations as of Phase 13. Bumps with every new migration —
    // adjust expected count when you add one.
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe('buildMigrationsCheck', () => {
  it('returns healthy when applied count meets expected', async () => {
    const db = {
      execute: async () => [{ n: '5' }],
    } as unknown as Database;
    const check = buildMigrationsCheck(db, { expectedCount: 5 });
    const res = await check();
    expect(res.healthy).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns unhealthy when applied count is below expected', async () => {
    const db = {
      execute: async () => [{ n: '2' }],
    } as unknown as Database;
    const check = buildMigrationsCheck(db, { expectedCount: 5 });
    const res = await check();
    expect(res.healthy).toBe(false);
  });

  it('returns unhealthy when the migrations table is missing', async () => {
    const db = {
      execute: async () => {
        throw new Error('relation drizzle.__drizzle_migrations does not exist');
      },
    } as unknown as Database;
    const check = buildMigrationsCheck(db, { expectedCount: 1 });
    const res = await check();
    expect(res.healthy).toBe(false);
  });
});
