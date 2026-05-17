import { eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { tenants, type NewTenant, type Tenant } from '../db/schema.js';

export interface CreateTenantInput {
  name: string;
  parentId?: string | null;
  inherit?: boolean;
}

export interface TenantsRepo {
  create(input: CreateTenantInput): Promise<Tenant>;
  get(id: string): Promise<Tenant | undefined>;
  listChildren(parentId: string | null): Promise<Tenant[]>;
  update(id: string, patch: Partial<Pick<Tenant, 'name' | 'inherit' | 'parentId'>>): Promise<Tenant | undefined>;
  getAncestors(tenantId: string): Promise<Tenant[]>;
  getEffectiveDescendants(tenantId: string, crossesBoundary: boolean): Promise<Tenant[]>;
  delete(id: string): Promise<boolean>;
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
  async getEffectiveDescendants(
    tenantId: string,
    crossesBoundary: boolean,
  ): Promise<Tenant[]> {
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
    const result = await this.db.delete(tenants).where(eq(tenants.id, id)).returning({ id: tenants.id });
    return result.length > 0;
  }
}

export type { Tenant } from '../db/schema.js';
