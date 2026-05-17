import type { Database, DbOrTx } from '../db/client.js';
import {
  RolesRepository,
  type CreateRoleInput,
  type Role,
  type RoleWithScopes,
} from '../repositories/roles.js';
import { OutboxRepository } from '../repositories/outbox.js';
import { AuditLogRepository } from '../repositories/audit-log.js';
import { NotFoundError } from './errors.js';
import { wrapConflict } from './conflict.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
}

export interface RolesService {
  create(input: CreateRoleInput, audit?: AuditRequestContext): Promise<Role>;
  get(id: string): Promise<Role>;
  getWithScopes(id: string): Promise<RoleWithScopes>;
  pageByTenant(tenantId: string, opts: PaginationOpts): Promise<PageResult<Role>>;
  addScopes(roleId: string, scopeIds: string[], audit?: AuditRequestContext): Promise<void>;
  removeScope(roleId: string, scopeId: string, audit?: AuditRequestContext): Promise<void>;
  update(id: string, patch: UpdateRoleInput, audit?: AuditRequestContext): Promise<Role>;
}

export interface RolesServiceDeps {
  db: Database;
}

// Snapshot stored in audit before/after for role.scope_add and role.scope_remove.
interface ScopeMembershipSnapshot {
  scopeIds: string[];
}

async function loadScopeIds(tx: DbOrTx, roleId: string): Promise<string[]> {
  const withScopes = await new RolesRepository(tx).getWithScopes(roleId);
  return withScopes ? withScopes.scopes.map((s) => s.id).sort() : [];
}

export class RolesServiceImpl implements RolesService {
  constructor(private readonly deps: RolesServiceDeps) {}

  async create(input: CreateRoleInput, audit?: AuditRequestContext): Promise<Role> {
    return wrapConflict(
      () =>
        this.deps.db.transaction(async (tx) => {
          const row = await new RolesRepository(tx).create(input);
          if (audit) {
            await new AuditLogRepository(tx).insert({
              ...audit,
              action: AUDIT_ACTIONS.roleCreate,
              targetType: AUDIT_TARGETS.role,
              targetId: row.id,
              tenantId: row.tenantId,
              before: null,
              after: row,
            });
          }
          return row;
        }),
      `role named "${input.name}" already exists in tenant ${input.tenantId}`,
    );
  }

  async get(id: string): Promise<Role> {
    const row = await new RolesRepository(this.deps.db).findById(id);
    if (!row) throw new NotFoundError(`role ${id} not found`);
    return row;
  }

  async getWithScopes(id: string): Promise<RoleWithScopes> {
    const row = await new RolesRepository(this.deps.db).getWithScopes(id);
    if (!row) throw new NotFoundError(`role ${id} not found`);
    return row;
  }

  async pageByTenant(tenantId: string, opts: PaginationOpts): Promise<PageResult<Role>> {
    return new RolesRepository(this.deps.db).pageForTenant(tenantId, opts);
  }

  async addScopes(roleId: string, scopeIds: string[], audit?: AuditRequestContext): Promise<void> {
    if (scopeIds.length === 0) return;
    await this.deps.db.transaction(async (tx) => {
      const roles = new RolesRepository(tx);
      const outbox = new OutboxRepository(tx);
      const role = await roles.findById(roleId);
      if (!role) throw new NotFoundError(`role ${roleId} not found`);

      const before: ScopeMembershipSnapshot | undefined = audit
        ? { scopeIds: await loadScopeIds(tx, roleId) }
        : undefined;

      await roles.addScopes(roleId, scopeIds);
      for (const scopeId of scopeIds) {
        await outbox.enqueue(tx, {
          aggregateType: 'role',
          aggregateId: roleId,
          payload: { kind: 'role.scope_added', roleId, scopeId },
        });
      }
      if (audit) {
        const after: ScopeMembershipSnapshot = { scopeIds: await loadScopeIds(tx, roleId) };
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.roleScopeAdd,
          targetType: AUDIT_TARGETS.role,
          targetId: roleId,
          tenantId: role.tenantId,
          before: before ?? null,
          after,
        });
      }
    });
  }

  async removeScope(roleId: string, scopeId: string, audit?: AuditRequestContext): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const roles = new RolesRepository(tx);
      const outbox = new OutboxRepository(tx);
      const role = await roles.findById(roleId);
      if (!role) throw new NotFoundError(`role ${roleId} not found`);

      const before: ScopeMembershipSnapshot | undefined = audit
        ? { scopeIds: await loadScopeIds(tx, roleId) }
        : undefined;

      await roles.removeScopes(roleId, [scopeId]);
      await outbox.enqueue(tx, {
        aggregateType: 'role',
        aggregateId: roleId,
        payload: { kind: 'role.scope_removed', roleId, scopeId },
      });
      if (audit) {
        const after: ScopeMembershipSnapshot = { scopeIds: await loadScopeIds(tx, roleId) };
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.roleScopeRemove,
          targetType: AUDIT_TARGETS.role,
          targetId: roleId,
          tenantId: role.tenantId,
          before: before ?? null,
          after,
        });
      }
    });
  }

  async update(id: string, patch: UpdateRoleInput, audit?: AuditRequestContext): Promise<Role> {
    return wrapConflict(
      () =>
        this.deps.db.transaction(async (tx) => {
          const repo = new RolesRepository(tx);
          const before = audit ? await repo.findById(id) : undefined;
          const after = await repo.update(id, patch);
          if (!after) throw new NotFoundError(`role ${id} not found`);
          if (audit) {
            await new AuditLogRepository(tx).insert({
              ...audit,
              action: AUDIT_ACTIONS.roleUpdate,
              targetType: AUDIT_TARGETS.role,
              targetId: id,
              tenantId: after.tenantId,
              before: before ?? null,
              after,
            });
          }
          return after;
        }),
      `role named "${patch.name ?? ''}" already exists in this tenant`,
    );
  }
}
