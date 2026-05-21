import { and, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { roleBindings, roleScopes, type RoleBinding } from '../db/schema.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';
import { paginate } from '../lib/pagination.js';

export interface CreateBindingInput {
  principalId: string;
  roleId: string;
  tenantId: string;
  grantedByPrincipalId?: string | null;
  expiresAt?: Date | null;
}

export interface ListBindingsOptions {
  /** When true (default), exclude revoked and expired bindings. */
  activeOnly?: boolean;
}

export interface PageBindingsFilters {
  tenantId: string;
  principalId?: string;
  activeOnly?: boolean;
}

export interface RoleBindingsRepo {
  create(input: CreateBindingInput): Promise<RoleBinding>;
  findById(id: string): Promise<RoleBinding | undefined>;
  listForPrincipal(principalId: string, opts?: ListBindingsOptions): Promise<RoleBinding[]>;
  listForTenant(tenantId: string, opts?: ListBindingsOptions): Promise<RoleBinding[]>;
  listForRole(roleId: string, opts?: ListBindingsOptions): Promise<RoleBinding[]>;
  pageBindings(
    filters: PageBindingsFilters,
    opts: PaginationOpts,
  ): Promise<PageResult<RoleBinding>>;
  revoke(id: string): Promise<RoleBinding | undefined>;
  /**
   * Active bindings (not revoked, not expired) where the bound role grants
   * the given scope to the given principal — excluding the given binding id.
   * Used by the materializer to answer "does any OTHER binding still grant
   * (principal, scope) anywhere?" before deleting an FGA tuple on revoke.
   */
  findOtherActiveBindingsForPrincipalScope(
    principalId: string,
    scopeId: string,
    excludeBindingId: string,
  ): Promise<RoleBinding[]>;
  /**
   * Same as findOtherActive... but without an exclusion. Used by
   * materializeRoleScopeRemoved: after role_scopes(role, scope) is deleted,
   * the join here naturally excludes bindings of the modified role, so a
   * non-empty result means OTHER roles still grant the (principal, scope).
   */
  findActiveBindingsForPrincipalScope(principalId: string, scopeId: string): Promise<RoleBinding[]>;
  /** Count of bindings for this principal that are not revoked and not expired. */
  countActiveForPrincipal(principalId: string): Promise<number>;
  /**
   * Revoke every active binding owned by the principal in a single UPDATE.
   * Returns the rows post-revoke so the service can enqueue one outbox event
   * per binding and audit the operation.
   */
  revokeAllForPrincipal(principalId: string): Promise<RoleBinding[]>;
}

export class RoleBindingsRepository implements RoleBindingsRepo {
  constructor(private readonly db: DbOrTx) {}

  async create(input: CreateBindingInput): Promise<RoleBinding> {
    const [row] = await this.db
      .insert(roleBindings)
      .values({
        id: newId(),
        principalId: input.principalId,
        roleId: input.roleId,
        tenantId: input.tenantId,
        grantedByPrincipalId: input.grantedByPrincipalId ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    if (!row) throw new Error('role_binding insert returned no row');
    return row;
  }

  async findById(id: string): Promise<RoleBinding | undefined> {
    const [row] = await this.db.select().from(roleBindings).where(eq(roleBindings.id, id)).limit(1);
    return row;
  }

  async listForPrincipal(
    principalId: string,
    opts: ListBindingsOptions = {},
  ): Promise<RoleBinding[]> {
    const activeOnly = opts.activeOnly ?? true;
    return this.db
      .select()
      .from(roleBindings)
      .where(
        activeOnly
          ? and(eq(roleBindings.principalId, principalId), activePredicate())
          : eq(roleBindings.principalId, principalId),
      );
  }

  async listForTenant(tenantId: string, opts: ListBindingsOptions = {}): Promise<RoleBinding[]> {
    const activeOnly = opts.activeOnly ?? true;
    return this.db
      .select()
      .from(roleBindings)
      .where(
        activeOnly
          ? and(eq(roleBindings.tenantId, tenantId), activePredicate())
          : eq(roleBindings.tenantId, tenantId),
      );
  }

  async listForRole(roleId: string, opts: ListBindingsOptions = {}): Promise<RoleBinding[]> {
    const activeOnly = opts.activeOnly ?? true;
    return this.db
      .select()
      .from(roleBindings)
      .where(
        activeOnly
          ? and(eq(roleBindings.roleId, roleId), activePredicate())
          : eq(roleBindings.roleId, roleId),
      );
  }

  async pageBindings(
    filters: PageBindingsFilters,
    opts: PaginationOpts,
  ): Promise<PageResult<RoleBinding>> {
    const activeOnly = filters.activeOnly ?? true;
    const where = and(
      eq(roleBindings.tenantId, filters.tenantId),
      filters.principalId ? eq(roleBindings.principalId, filters.principalId) : undefined,
      activeOnly ? activePredicate() : undefined,
      opts.cursor ? gt(roleBindings.id, opts.cursor) : undefined,
    );
    const rows = await this.db
      .select()
      .from(roleBindings)
      .where(where)
      .orderBy(roleBindings.id)
      .limit(opts.limit + 1);
    return paginate(rows, opts.limit, (r) => r.id);
  }

  async revoke(id: string): Promise<RoleBinding | undefined> {
    const [row] = await this.db
      .update(roleBindings)
      .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(roleBindings.id, id))
      .returning();
    return row;
  }

  async findOtherActiveBindingsForPrincipalScope(
    principalId: string,
    scopeId: string,
    excludeBindingId: string,
  ): Promise<RoleBinding[]> {
    const rows = await this.db
      .select({ rb: roleBindings })
      .from(roleBindings)
      .innerJoin(roleScopes, eq(roleScopes.roleId, roleBindings.roleId))
      .where(
        and(
          eq(roleBindings.principalId, principalId),
          eq(roleScopes.scopeId, scopeId),
          ne(roleBindings.id, excludeBindingId),
          activePredicate(),
        ),
      );
    return rows.map((r: { rb: RoleBinding }) => r.rb);
  }

  async findActiveBindingsForPrincipalScope(
    principalId: string,
    scopeId: string,
  ): Promise<RoleBinding[]> {
    const rows = await this.db
      .select({ rb: roleBindings })
      .from(roleBindings)
      .innerJoin(roleScopes, eq(roleScopes.roleId, roleBindings.roleId))
      .where(
        and(
          eq(roleBindings.principalId, principalId),
          eq(roleScopes.scopeId, scopeId),
          activePredicate(),
        ),
      );
    return rows.map((r: { rb: RoleBinding }) => r.rb);
  }

  async countActiveForPrincipal(principalId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<string>`count(*)::text` })
      .from(roleBindings)
      .where(and(eq(roleBindings.principalId, principalId), activePredicate()));
    return Number(row?.n ?? '0');
  }

  async revokeAllForPrincipal(principalId: string): Promise<RoleBinding[]> {
    const rows = await this.db
      .update(roleBindings)
      .set({ revokedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(roleBindings.principalId, principalId), activePredicate()))
      .returning();
    return rows;
  }
}

function activePredicate() {
  return and(
    isNull(roleBindings.revokedAt),
    or(isNull(roleBindings.expiresAt), gt(roleBindings.expiresAt, sql`now()`)),
  );
}

export type { RoleBinding } from '../db/schema.js';
