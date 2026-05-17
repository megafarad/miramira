import type { Database } from '../db/client.js';
import {
  RoleBindingsRepository,
  type CreateBindingInput,
  type RoleBinding,
} from '../repositories/role-bindings.js';
import { OutboxRepository } from '../repositories/outbox.js';
import { AuditLogRepository } from '../repositories/audit-log.js';
import { NotFoundError, ValidationError } from './errors.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';

export interface ListBindingsInput {
  tenantId?: string;
  principalId?: string;
  includeRevoked?: boolean;
}

export interface RoleBindingsService {
  create(input: CreateBindingInput, audit?: AuditRequestContext): Promise<RoleBinding>;
  revoke(id: string, audit?: AuditRequestContext): Promise<RoleBinding>;
  get(id: string): Promise<RoleBinding>;
  list(input: ListBindingsInput): Promise<RoleBinding[]>;
}

export interface RoleBindingsServiceDeps {
  db: Database;
}

export class RoleBindingsServiceImpl implements RoleBindingsService {
  constructor(private readonly deps: RoleBindingsServiceDeps) {}

  async create(
    input: CreateBindingInput,
    audit?: AuditRequestContext,
  ): Promise<RoleBinding> {
    return this.deps.db.transaction(async (tx) => {
      const bindings = new RoleBindingsRepository(tx);
      const outbox = new OutboxRepository(tx);

      const row = await bindings.create(input);
      await outbox.enqueue(tx, {
        aggregateType: 'role_binding',
        aggregateId: row.id,
        payload: {
          kind: 'role_binding.created',
          bindingId: row.id,
          principalId: row.principalId,
          roleId: row.roleId,
          tenantId: row.tenantId,
        },
      });
      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.roleBindingCreate,
          targetType: AUDIT_TARGETS.roleBinding,
          targetId: row.id,
          tenantId: row.tenantId,
          before: null,
          after: row,
        });
      }
      return row;
    });
  }

  async revoke(id: string, audit?: AuditRequestContext): Promise<RoleBinding> {
    return this.deps.db.transaction(async (tx) => {
      const bindings = new RoleBindingsRepository(tx);
      const outbox = new OutboxRepository(tx);

      const before = audit ? await bindings.findById(id) : undefined;
      const row = await bindings.revoke(id);
      if (!row) throw new NotFoundError(`role binding ${id} not found`);

      await outbox.enqueue(tx, {
        aggregateType: 'role_binding',
        aggregateId: row.id,
        payload: { kind: 'role_binding.revoked', bindingId: row.id },
      });
      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.roleBindingRevoke,
          targetType: AUDIT_TARGETS.roleBinding,
          targetId: id,
          tenantId: row.tenantId,
          before: before ?? null,
          after: row,
        });
      }
      return row;
    });
  }

  async get(id: string): Promise<RoleBinding> {
    const row = await new RoleBindingsRepository(this.deps.db).findById(id);
    if (!row) throw new NotFoundError(`role binding ${id} not found`);
    return row;
  }

  async list(input: ListBindingsInput): Promise<RoleBinding[]> {
    if (!input.tenantId && !input.principalId) {
      throw new ValidationError('list requires tenantId or principalId');
    }
    const repo = new RoleBindingsRepository(this.deps.db);
    const activeOnly = !input.includeRevoked;
    if (input.tenantId && input.principalId) {
      const byTenant = await repo.listForTenant(input.tenantId, { activeOnly });
      return byTenant.filter((b) => b.principalId === input.principalId);
    }
    if (input.tenantId) {
      return repo.listForTenant(input.tenantId, { activeOnly });
    }
    return repo.listForPrincipal(input.principalId!, { activeOnly });
  }
}
