import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { principals, type Principal } from '../db/schema.js';

export interface PrincipalsRepo {
  ensureForUser(userId: string): Promise<Principal>;
  ensureForApiKey(apiKeyId: string): Promise<Principal>;
  findById(id: string): Promise<Principal | undefined>;
  findByUserId(userId: string): Promise<Principal | undefined>;
  findByApiKeyId(apiKeyId: string): Promise<Principal | undefined>;
}

export class PrincipalsRepository implements PrincipalsRepo {
  constructor(private readonly db: DbOrTx) {}

  /**
   * Return the principal row for the given user, creating one if absent.
   * The `principals.user_id` unique index guarantees there is at most one.
   */
  async ensureForUser(userId: string): Promise<Principal> {
    const [row] = await this.db
      .insert(principals)
      .values({ id: newId(), kind: 'user', userId })
      .onConflictDoUpdate({
        target: principals.userId,
        set: { kind: 'user' }, // no-op; needed to get the existing row back via RETURNING
      })
      .returning();
    if (!row) throw new Error('principal upsert returned no row');
    return row;
  }

  async ensureForApiKey(apiKeyId: string): Promise<Principal> {
    const [row] = await this.db
      .insert(principals)
      .values({ id: newId(), kind: 'api_key', apiKeyId })
      .onConflictDoUpdate({
        target: principals.apiKeyId,
        set: { kind: 'api_key' },
      })
      .returning();
    if (!row) throw new Error('principal upsert returned no row');
    return row;
  }

  async findById(id: string): Promise<Principal | undefined> {
    const [row] = await this.db.select().from(principals).where(eq(principals.id, id)).limit(1);
    return row;
  }

  async findByUserId(userId: string): Promise<Principal | undefined> {
    const [row] = await this.db
      .select()
      .from(principals)
      .where(eq(principals.userId, userId))
      .limit(1);
    return row;
  }

  async findByApiKeyId(apiKeyId: string): Promise<Principal | undefined> {
    const [row] = await this.db
      .select()
      .from(principals)
      .where(eq(principals.apiKeyId, apiKeyId))
      .limit(1);
    return row;
  }
}

export type { Principal } from '../db/schema.js';
