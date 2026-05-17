import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { scopes, tenants, type Scope } from '../db/schema.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';
import { paginate } from '../lib/pagination.js';

export interface CreateScopeInput {
  tenantId: string;
  name: string;
  description?: string | null;
}

export interface ScopesRepo {
  create(input: CreateScopeInput): Promise<Scope>;
  findById(id: string): Promise<Scope | undefined>;
  findByName(tenantId: string, name: string): Promise<Scope | undefined>;
  findByNameInAncestors(tenantId: string, name: string): Promise<Scope | undefined>;
  listForTenant(tenantId: string): Promise<Scope[]>;
  pageForTenant(tenantId: string, opts: PaginationOpts): Promise<PageResult<Scope>>;
  listByIds(ids: string[]): Promise<Scope[]>;
  update(
    id: string,
    patch: Partial<Pick<Scope, 'name' | 'description'>>,
  ): Promise<Scope | undefined>;
  delete(id: string): Promise<boolean>;
}

export class ScopesRepository implements ScopesRepo {
  constructor(private readonly db: DbOrTx) {}

  async create(input: CreateScopeInput): Promise<Scope> {
    const [row] = await this.db
      .insert(scopes)
      .values({
        id: newId(),
        tenantId: input.tenantId,
        name: input.name,
        description: input.description ?? null,
      })
      .returning();
    if (!row) throw new Error('scope insert returned no row');
    return row;
  }

  async findById(id: string): Promise<Scope | undefined> {
    const [row] = await this.db.select().from(scopes).where(eq(scopes.id, id)).limit(1);
    return row;
  }

  async findByName(tenantId: string, name: string): Promise<Scope | undefined> {
    const [row] = await this.db
      .select()
      .from(scopes)
      .where(and(eq(scopes.tenantId, tenantId), eq(scopes.name, name)))
      .limit(1);
    return row;
  }

  /**
   * Walk the ancestor chain from `tenantId` up to the root and return the
   * first matching scope (most-specific wins — the tenant's own definition
   * takes precedence over an ancestor's). Used by /check to resolve a scope
   * by name against the caller's tenant context.
   */
  async findByNameInAncestors(tenantId: string, name: string): Promise<Scope | undefined> {
    const rows = await this.db.execute<Scope>(sql`
      WITH RECURSIVE chain AS (
        SELECT t.id AS tenant_id, t.parent_id AS parent_id, 0 AS depth
        FROM ${tenants} t
        WHERE t.id = ${tenantId}
        UNION ALL
        SELECT t.id AS tenant_id, t.parent_id AS parent_id, c.depth + 1
        FROM ${tenants} t
        JOIN chain c ON t.id = c.parent_id
      )
      SELECT s.id, s.tenant_id AS "tenantId", s.name, s.description,
             s.created_at AS "createdAt", s.updated_at AS "updatedAt"
      FROM ${scopes} s
      JOIN chain c ON s.tenant_id = c.tenant_id
      WHERE s.name = ${name}
      ORDER BY c.depth ASC
      LIMIT 1
    `);
    return rows[0];
  }

  async listForTenant(tenantId: string): Promise<Scope[]> {
    return this.db.select().from(scopes).where(eq(scopes.tenantId, tenantId));
  }

  async pageForTenant(
    tenantId: string,
    opts: PaginationOpts,
  ): Promise<PageResult<Scope>> {
    const base = eq(scopes.tenantId, tenantId);
    const where = opts.cursor ? and(base, gt(scopes.id, opts.cursor)) : base;
    const rows = await this.db
      .select()
      .from(scopes)
      .where(where)
      .orderBy(scopes.id)
      .limit(opts.limit + 1);
    return paginate(rows, opts.limit, (r) => r.id);
  }

  async listByIds(ids: string[]): Promise<Scope[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(scopes).where(inArray(scopes.id, ids));
  }

  async update(
    id: string,
    patch: Partial<Pick<Scope, 'name' | 'description'>>,
  ): Promise<Scope | undefined> {
    const [row] = await this.db
      .update(scopes)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(scopes.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(scopes).where(eq(scopes.id, id)).returning({ id: scopes.id });
    return result.length > 0;
  }
}

export type { Scope } from '../db/schema.js';
