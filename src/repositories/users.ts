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
}

export type { User } from '../db/schema.js';
