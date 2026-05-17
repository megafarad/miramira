import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { roleScopes, roles, scopes, type Role, type Scope } from '../db/schema.js';

export interface CreateRoleInput {
  tenantId: string;
  name: string;
  description?: string | null;
  crossesBoundary?: boolean;
}

export interface RoleWithScopes {
  role: Role;
  scopes: Scope[];
}

export interface RolesRepo {
  create(input: CreateRoleInput): Promise<Role>;
  findById(id: string): Promise<Role | undefined>;
  findByName(tenantId: string, name: string): Promise<Role | undefined>;
  listForTenant(tenantId: string): Promise<Role[]>;
  getWithScopes(roleId: string): Promise<RoleWithScopes | undefined>;
  addScopes(roleId: string, scopeIds: string[]): Promise<void>;
  removeScopes(roleId: string, scopeIds: string[]): Promise<void>;
  update(
    id: string,
    patch: Partial<Pick<Role, 'name' | 'description' | 'crossesBoundary'>>,
  ): Promise<Role | undefined>;
  delete(id: string): Promise<boolean>;
}

export class RolesRepository implements RolesRepo {
  constructor(private readonly db: DbOrTx) {}

  async create(input: CreateRoleInput): Promise<Role> {
    const [row] = await this.db
      .insert(roles)
      .values({
        id: newId(),
        tenantId: input.tenantId,
        name: input.name,
        description: input.description ?? null,
        crossesBoundary: input.crossesBoundary ?? false,
      })
      .returning();
    if (!row) throw new Error('role insert returned no row');
    return row;
  }

  async findById(id: string): Promise<Role | undefined> {
    const [row] = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
    return row;
  }

  async findByName(tenantId: string, name: string): Promise<Role | undefined> {
    const [row] = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, tenantId), eq(roles.name, name)))
      .limit(1);
    return row;
  }

  async listForTenant(tenantId: string): Promise<Role[]> {
    return this.db.select().from(roles).where(eq(roles.tenantId, tenantId));
  }

  async getWithScopes(roleId: string): Promise<RoleWithScopes | undefined> {
    const role = await this.findById(roleId);
    if (!role) return undefined;
    const rows = await this.db
      .select({ scope: scopes })
      .from(roleScopes)
      .innerJoin(scopes, eq(scopes.id, roleScopes.scopeId))
      .where(eq(roleScopes.roleId, roleId));
    return { role, scopes: rows.map((r: { scope: Scope }) => r.scope) };
  }

  async addScopes(roleId: string, scopeIds: string[]): Promise<void> {
    if (scopeIds.length === 0) return;
    await this.db
      .insert(roleScopes)
      .values(scopeIds.map((scopeId) => ({ roleId, scopeId })))
      .onConflictDoNothing();
  }

  async removeScopes(roleId: string, scopeIds: string[]): Promise<void> {
    if (scopeIds.length === 0) return;
    await this.db
      .delete(roleScopes)
      .where(and(eq(roleScopes.roleId, roleId), inArray(roleScopes.scopeId, scopeIds)));
  }

  async update(
    id: string,
    patch: Partial<Pick<Role, 'name' | 'description' | 'crossesBoundary'>>,
  ): Promise<Role | undefined> {
    const [row] = await this.db
      .update(roles)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(roles.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(roles).where(eq(roles.id, id)).returning({ id: roles.id });
    return result.length > 0;
  }
}

export type { Role, RoleScope } from '../db/schema.js';
