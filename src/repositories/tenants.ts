import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { apiKeys, roleBindings, tenants, type NewTenant, type Tenant } from '../db/schema.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';
import { paginate } from '../lib/pagination.js';

export interface CreateTenantInput {
  name: string;
  parentId?: string | null;
  inherit?: boolean;
}

export interface TenantsRepo {
  create(input: CreateTenantInput): Promise<Tenant>;
  get(id: string): Promise<Tenant | undefined>;
  listChildren(parentId: string | null): Promise<Tenant[]>;
  pageChildren(parentId: string | null, opts: PaginationOpts): Promise<PageResult<Tenant>>;
  update(
    id: string,
    patch: Partial<Pick<Tenant, 'name' | 'inherit' | 'parentId'>>,
  ): Promise<Tenant | undefined>;
  getAncestors(tenantId: string): Promise<Tenant[]>;
  getEffectiveDescendants(tenantId: string, crossesBoundary: boolean): Promise<Tenant[]>;
  delete(id: string): Promise<boolean>;
  /** Direct-child count. Used by the delete-blocker checks. */
  countChildren(id: string): Promise<number>;
  /** Any-state api_key count (active OR revoked). Used by the delete-blocker checks. */
  countApiKeys(id: string): Promise<number>;
  /**
   * Count of role_bindings at this tenant that are still active
   * (not revoked and not expired). Used by the delete-blocker checks.
   */
  countActiveBindings(id: string): Promise<number>;
}

export class TenantsRepository implements TenantsRepo {
  constructor(private readonly db: DbOrTx) {}

  async create(input: CreateTenantInput): Promise<Tenant> {
    const row: NewTenant = {
      id: newId(),
      name: input.name,
      parentId: input.parentId ?? null,
      inherit: input.inherit ?? true,
    };
    const [created] = await this.db.insert(tenants).values(row).returning();
    if (!created) throw new Error('tenant insert returned no row');
    return created;
  }

  async get(id: string): Promise<Tenant | undefined> {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return row;
  }

  async listChildren(parentId: string | null): Promise<Tenant[]> {
    return this.db
      .select()
      .from(tenants)
      .where(parentId === null ? isNull(tenants.parentId) : eq(tenants.parentId, parentId));
  }

  async pageChildren(parentId: string | null, opts: PaginationOpts): Promise<PageResult<Tenant>> {
    const parentPred =
      parentId === null ? isNull(tenants.parentId) : eq(tenants.parentId, parentId);
    const where = opts.cursor ? and(parentPred, gt(tenants.id, opts.cursor)) : parentPred;
    const rows = await this.db
      .select()
      .from(tenants)
      .where(where)
      .orderBy(tenants.id)
      .limit(opts.limit + 1);
    return paginate(rows, opts.limit, (r) => r.id);
  }

  async update(
    id: string,
    patch: Partial<Pick<Tenant, 'name' | 'inherit' | 'parentId'>>,
  ): Promise<Tenant | undefined> {
    const [row] = await this.db
      .update(tenants)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(tenants.id, id))
      .returning();
    return row;
  }

  /**
   * Returns the tenant and all descendants reachable under the inheritance
   * rules. With `crossesBoundary = false`, descent stops at any child whose
   * `inherit = false` (that child and its subtree are excluded). With
   * `crossesBoundary = true`, ALL descendants are returned regardless of
   * inherit flags.
   */
  async getEffectiveDescendants(tenantId: string, crossesBoundary: boolean): Promise<Tenant[]> {
    const rows = await this.db.execute<Tenant>(sql`
      WITH RECURSIVE descs AS (
        SELECT id, parent_id, name, inherit, created_at, updated_at, 0 AS depth
        FROM ${tenants}
        WHERE id = ${tenantId}
        UNION ALL
        SELECT t.id, t.parent_id, t.name, t.inherit, t.created_at, t.updated_at, d.depth + 1
        FROM ${tenants} t
        JOIN descs d ON t.parent_id = d.id
        WHERE ${crossesBoundary} OR t.inherit = true
      )
      SELECT id, parent_id AS "parentId", name, inherit,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM descs
      ORDER BY depth
    `);
    return [...rows];
  }

  /**
   * Returns the tenant and all ancestors, root-first. The given tenant is the
   * last element. Returns an empty array if the tenant does not exist.
   */
  async getAncestors(tenantId: string): Promise<Tenant[]> {
    const rows = await this.db.execute<Tenant>(sql`
      WITH RECURSIVE chain AS (
        SELECT t.*, 0 AS depth
        FROM ${tenants} t
        WHERE t.id = ${tenantId}
        UNION ALL
        SELECT t.*, c.depth + 1
        FROM ${tenants} t
        JOIN chain c ON t.id = c.parent_id
      )
      SELECT id, parent_id AS "parentId", name, inherit,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM chain
      ORDER BY depth DESC
    `);
    return [...rows];
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(tenants)
      .where(eq(tenants.id, id))
      .returning({ id: tenants.id });
    return result.length > 0;
  }

  async countChildren(id: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<string>`count(*)::text` })
      .from(tenants)
      .where(eq(tenants.parentId, id));
    return Number(row?.n ?? '0');
  }

  async countApiKeys(id: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<string>`count(*)::text` })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, id));
    return Number(row?.n ?? '0');
  }

  async countActiveBindings(id: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<string>`count(*)::text` })
      .from(roleBindings)
      .where(
        and(
          eq(roleBindings.tenantId, id),
          isNull(roleBindings.revokedAt),
          or(isNull(roleBindings.expiresAt), gt(roleBindings.expiresAt, sql`now()`)),
        ),
      );
    return Number(row?.n ?? '0');
  }
}

export type { Tenant } from '../db/schema.js';
