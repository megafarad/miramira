import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { emailId } from '../../src/lib/email.js';

describe.skipIf(!(await isDbReachable()))('UsersRepository', () => {
  let users: UsersRepository;

  beforeAll(() => {
    users = new UsersRepository(getTestDb().db);
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('upsertByEmailId inserts a new user with the SHA-256 of the normalized email', async () => {
    const u = await users.upsertByEmailId('Alice@Example.com');
    expect(u.email).toBe('Alice@Example.com');
    expect(u.emailId).toBe(emailId('Alice@Example.com'));
    expect(u.supabaseUserId).toBeNull();
  });

  it('upsertByEmailId is idempotent across casing/whitespace variants', async () => {
    const first = await users.upsertByEmailId('alice@example.com');
    const second = await users.upsertByEmailId('  Alice@Example.COM  ');
    expect(second.id).toBe(first.id);
  });

  it('findByEmail and findBySupabaseId locate the same row after backfill', async () => {
    const u = await users.upsertByEmailId('bob@example.com');
    expect(await users.findBySupabaseId('sub-xyz')).toBeUndefined();
    await users.backfillSupabaseId(u.id, 'sub-xyz');
    const byEmail = await users.findByEmail('bob@example.com');
    const bySub = await users.findBySupabaseId('sub-xyz');
    expect(byEmail?.id).toBe(u.id);
    expect(bySub?.id).toBe(u.id);
  });

  it('backfillSupabaseId is idempotent when called twice with the same sub', async () => {
    const u = await users.upsertByEmailId('carol@example.com');
    const first = await users.backfillSupabaseId(u.id, 'sub-carol');
    const second = await users.backfillSupabaseId(u.id, 'sub-carol');
    expect(first?.supabaseUserId).toBe('sub-carol');
    expect(second?.supabaseUserId).toBe('sub-carol');
  });

  it('updateEmail rewrites both the raw email and the email_id hash', async () => {
    const u = await users.upsertByEmailId('old@example.com');
    const after = await users.updateEmail(u.id, 'new@example.com');
    expect(after?.email).toBe('new@example.com');
    expect(after?.emailId).toBe(emailId('new@example.com'));
    // Subsequent lookups by the new email find the row; lookups by the old
    // email no longer do.
    expect(await users.findByEmail('new@example.com')).toBeDefined();
    expect(await users.findByEmail('old@example.com')).toBeUndefined();
  });

  it('updateEmail returns null when the new email already belongs to another user', async () => {
    const other = await users.upsertByEmailId('taken@example.com');
    const u = await users.upsertByEmailId('moving@example.com');
    const result = await users.updateEmail(u.id, 'taken@example.com');
    expect(result).toBeNull();
    // Source row is untouched.
    const refreshed = await users.findById(u.id);
    expect(refreshed?.email).toBe('moving@example.com');
    // Conflicting row also untouched.
    expect((await users.findById(other.id))?.email).toBe('taken@example.com');
  });
});

describe.skipIf(!(await isDbReachable()))('PrincipalsRepository', () => {
  let users: UsersRepository;
  let principals: PrincipalsRepository;

  beforeAll(() => {
    const { db } = getTestDb();
    users = new UsersRepository(db);
    principals = new PrincipalsRepository(db);
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('ensureForUser creates a principal then returns the same row on a second call', async () => {
    const u = await users.upsertByEmailId('dan@example.com');
    const p1 = await principals.ensureForUser(u.id);
    const p2 = await principals.ensureForUser(u.id);
    expect(p1.id).toBe(p2.id);
    expect(p1.kind).toBe('user');
    expect(p1.userId).toBe(u.id);
    expect(p1.apiKeyId).toBeNull();
  });

  it('findByUserId returns the principal for a known user', async () => {
    const u = await users.upsertByEmailId('eve@example.com');
    const p = await principals.ensureForUser(u.id);
    const found = await principals.findByUserId(u.id);
    expect(found?.id).toBe(p.id);
  });
});
