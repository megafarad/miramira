import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { emailId as computeEmailId } from '../lib/email.js';
import { users, type User } from '../db/schema.js';

export interface UsersRepo {
  upsertByEmailId(email: string): Promise<User>;
  findById(id: string): Promise<User | undefined>;
  findBySupabaseId(supabaseUserId: string): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  backfillSupabaseId(userId: string, supabaseUserId: string): Promise<User | undefined>;
  /**
   * Replace the email on an existing row. Updates both `email` (raw) and
   * `email_id` (hash) so future lookups by either still resolve. Returns
   * `null` if the new email's hash collides with another user — callers
   * should treat this as a soft failure (log + continue), not throw.
   */
  updateEmail(userId: string, newEmail: string): Promise<User | null>;
}

export class UsersRepository implements UsersRepo {
  constructor(private readonly db: DbOrTx) {}

  /**
   * Insert a user keyed by the email hash, or return the existing row if one
   * already exists. Stores the raw email for display. Does NOT touch
   * `supabaseUserId` — that is backfilled by {@link backfillSupabaseId} once
   * a JWT-authenticated request arrives.
   */
  async upsertByEmailId(email: string): Promise<User> {
    const emailIdHash = computeEmailId(email);
    const [row] = await this.db
      .insert(users)
      .values({ id: newId(), emailId: emailIdHash, email })
      .onConflictDoUpdate({
        target: users.emailId,
        // No-op update so RETURNING gives back the existing row.
        set: { email },
      })
      .returning();
    if (!row) throw new Error('user upsert returned no row');
    return row;
  }

  async findById(id: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row;
  }

  async findBySupabaseId(supabaseUserId: string): Promise<User | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.supabaseUserId, supabaseUserId))
      .limit(1);
    return row;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const emailIdHash = computeEmailId(email);
    const [row] = await this.db.select().from(users).where(eq(users.emailId, emailIdHash)).limit(1);
    return row;
  }

  /**
   * Attach a Supabase `sub` to an existing user. Idempotent: if the same value
   * is already set, returns the row unchanged. Throws on conflict with another
   * row holding the same `sub`.
   */
  async backfillSupabaseId(userId: string, supabaseUserId: string): Promise<User | undefined> {
    const [row] = await this.db
      .update(users)
      .set({ supabaseUserId, updatedAt: sql`now()` })
      .where(eq(users.id, userId))
      .returning();
    return row;
  }

  async updateEmail(userId: string, newEmail: string): Promise<User | null> {
    const newEmailIdHash = computeEmailId(newEmail);
    try {
      const [row] = await this.db
        .update(users)
        .set({ email: newEmail, emailId: newEmailIdHash, updatedAt: sql`now()` })
        .where(eq(users.id, userId))
        .returning();
      return row ?? null;
    } catch (err) {
      // Uniqueness conflict on users_email_id_uq: another local user already
      // owns this email. Signal to the caller via null so they can decide
      // whether to fail the request or proceed with the stale email.
      if (isUniqueViolation(err, 'users_email_id_uq')) return null;
      throw err;
    }
  }
}

// postgres-js surfaces Postgres errors as objects with `code` (SQLSTATE) and
// `constraint_name`. 23505 is unique_violation; the constraint discriminates
// which unique index tripped. Drizzle sometimes re-throws the PostgresError
// directly and sometimes wraps it in another Error with a `cause`, so we
// walk the chain. Narrow guard so we don't swallow unrelated errors that
// happen to be thrown from the same code path.
function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let cur: unknown = err; cur !== undefined && cur !== null; ) {
    if (typeof cur !== 'object') return false;
    const e = cur as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (e.code === '23505' && e.constraint_name === constraint) return true;
    cur = e.cause;
  }
  return false;
}

export type { User } from '../db/schema.js';
