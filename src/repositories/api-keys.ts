import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { hashApiKey, mintApiKey, type MintedApiKey } from '../lib/api-key.js';
import { apiKeys, type ApiKey } from '../db/schema.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';
import { paginate } from '../lib/pagination.js';

export interface CreateApiKeyInput {
  label: string;
  tenantId: string;
  createdByUserId?: string | null;
  expiresAt?: Date | null;
}

export interface CreateApiKeyResult {
  row: ApiKey;
  /** The full secret. Shown to the user exactly once; never persisted. */
  secret: string;
}

export interface ApiKeysRepo {
  create(input: CreateApiKeyInput): Promise<CreateApiKeyResult>;
  findById(id: string): Promise<ApiKey | undefined>;
  findActiveBySecret(secret: string): Promise<ApiKey | undefined>;
  listForTenant(tenantId: string): Promise<ApiKey[]>;
  pageForTenant(tenantId: string, opts: PaginationOpts): Promise<PageResult<ApiKey>>;
  revoke(id: string): Promise<ApiKey | undefined>;
  touchLastUsed(id: string, when?: Date): Promise<void>;
}

export class ApiKeysRepository implements ApiKeysRepo {
  constructor(private readonly db: DbOrTx) {}

  async create(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    const minted: MintedApiKey = mintApiKey();
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        id: newId(),
        keyHash: minted.hash,
        keyPrefix: minted.prefix,
        label: input.label,
        tenantId: input.tenantId,
        createdByUserId: input.createdByUserId ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    if (!row) throw new Error('api_key insert returned no row');
    return { row, secret: minted.secret };
  }

  async findById(id: string): Promise<ApiKey | undefined> {
    const [row] = await this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    return row;
  }

  /**
   * Look up an active (non-revoked, non-expired) key by its secret. Returns
   * undefined if the hash does not match, the key was revoked, or it expired.
   */
  async findActiveBySecret(secret: string): Promise<ApiKey | undefined> {
    const hash = hashApiKey(secret);
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;
    return row;
  }

  async listForTenant(tenantId: string): Promise<ApiKey[]> {
    return this.db.select().from(apiKeys).where(eq(apiKeys.tenantId, tenantId));
  }

  async pageForTenant(tenantId: string, opts: PaginationOpts): Promise<PageResult<ApiKey>> {
    const base = eq(apiKeys.tenantId, tenantId);
    const where = opts.cursor ? and(base, gt(apiKeys.id, opts.cursor)) : base;
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(where)
      .orderBy(apiKeys.id)
      .limit(opts.limit + 1);
    return paginate(rows, opts.limit, (r) => r.id);
  }

  async revoke(id: string): Promise<ApiKey | undefined> {
    const [row] = await this.db
      .update(apiKeys)
      .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(apiKeys.id, id))
      .returning();
    return row;
  }

  async touchLastUsed(id: string, when?: Date): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: when ?? sql`now()` })
      .where(eq(apiKeys.id, id));
  }
}

export type { ApiKey } from '../db/schema.js';
