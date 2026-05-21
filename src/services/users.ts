import type { Database } from '../db/client.js';
import { UsersRepository, type User } from '../repositories/users.js';
import { RoleBindingsRepository, type RoleBinding } from '../repositories/role-bindings.js';
import { PrincipalsRepository } from '../repositories/principals.js';
import { OutboxRepository } from '../repositories/outbox.js';
import { AuditLogRepository } from '../repositories/audit-log.js';
import { ConflictError, NotFoundError } from './errors.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';

/**
 * Maximum active bindings a single revoke-all call will process. Above this,
 * the call returns 409 and the operator must page through bindings manually.
 * Keeps the transaction footprint bounded — every revoked binding writes one
 * outbox row in the same tx.
 */
export const REVOKE_ALL_BINDINGS_CAP = 500;

export interface RevokeAllResult {
  revoked: number;
  bindingIds: string[];
}

export interface UsersService {
  /** Lookup including soft-deleted rows. */
  get(id: string): Promise<User>;
  /**
   * Set `disabled_at` on the user. Idempotent: a no-op call (already disabled)
   * returns the existing row without writing audit. 404 if the user is missing
   * or soft-deleted.
   */
  disable(id: string, audit?: AuditRequestContext): Promise<User>;
  /** Inverse of {@link disable}; same idempotency rules. */
  enable(id: string, audit?: AuditRequestContext): Promise<User>;
  /**
   * Bulk-revoke every active binding owned by this user's principal. Emits one
   * outbox `role_binding.revoked` event per revoked row so the materializer
   * tears down FGA tuples. Refuses with 409 when the count exceeds the cap.
   */
  revokeAllBindings(id: string, audit?: AuditRequestContext): Promise<RevokeAllResult>;
  /**
   * Soft-delete: set `deleted_at`, null out `supabase_user_id`. Refuses when
   * the user still has active bindings — operators must call
   * {@link revokeAllBindings} first.
   */
  delete(id: string, audit?: AuditRequestContext): Promise<void>;
}

export interface UsersServiceDeps {
  db: Database;
}

export class UsersServiceImpl implements UsersService {
  constructor(private readonly deps: UsersServiceDeps) {}

  async get(id: string): Promise<User> {
    const row = await new UsersRepository(this.deps.db).findByIdIncludingDeleted(id);
    if (!row) throw new NotFoundError(`user ${id} not found`);
    return row;
  }

  async disable(id: string, audit?: AuditRequestContext): Promise<User> {
    return this.deps.db.transaction(async (tx) => {
      const users = new UsersRepository(tx);
      const before = await users.findByIdIncludingDeleted(id);
      if (!before) throw new NotFoundError(`user ${id} not found`);
      if (before.deletedAt) {
        // Soft-deleted users can't be disabled — they're already past that
        // gate. Use the same blocker shape as delete() for consistency.
        throw new ConflictError(`cannot disable user: already deleted`);
      }
      // No-op when already disabled — return the existing row, skip audit.
      const after = await users.disable(id);
      if (!after) return before;
      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.userDisable,
          targetType: AUDIT_TARGETS.user,
          targetId: id,
          tenantId: null,
          before,
          after,
        });
      }
      return after;
    });
  }

  async enable(id: string, audit?: AuditRequestContext): Promise<User> {
    return this.deps.db.transaction(async (tx) => {
      const users = new UsersRepository(tx);
      const before = await users.findByIdIncludingDeleted(id);
      if (!before) throw new NotFoundError(`user ${id} not found`);
      if (before.deletedAt) {
        throw new ConflictError(`cannot enable user: already deleted`);
      }
      const after = await users.enable(id);
      if (!after) return before;
      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.userEnable,
          targetType: AUDIT_TARGETS.user,
          targetId: id,
          tenantId: null,
          before,
          after,
        });
      }
      return after;
    });
  }

  async revokeAllBindings(id: string, audit?: AuditRequestContext): Promise<RevokeAllResult> {
    return this.deps.db.transaction(async (tx) => {
      const users = new UsersRepository(tx);
      const bindings = new RoleBindingsRepository(tx);
      const outbox = new OutboxRepository(tx);

      const user = await users.findByIdIncludingDeleted(id);
      if (!user) throw new NotFoundError(`user ${id} not found`);

      const principal = await new PrincipalsRepository(tx).findByUserId(id);
      if (!principal) {
        // A user without a principal has no bindings by construction. Return
        // an empty result rather than 404; the user exists, there's just
        // nothing to revoke.
        return { revoked: 0, bindingIds: [] };
      }

      const activeCount = await bindings.countActiveForPrincipal(principal.id);
      if (activeCount > REVOKE_ALL_BINDINGS_CAP) {
        throw new ConflictError(
          `cannot revoke all bindings: user has ${activeCount} active bindings ` +
            `(cap: ${REVOKE_ALL_BINDINGS_CAP}); revoke individually or in pages`,
        );
      }
      if (activeCount === 0) {
        return { revoked: 0, bindingIds: [] };
      }

      const revoked = await bindings.revokeAllForPrincipal(principal.id);
      for (const row of revoked) {
        await outbox.enqueue(tx, {
          aggregateType: 'role_binding',
          aggregateId: row.id,
          payload: { kind: 'role_binding.revoked', bindingId: row.id },
        });
      }
      const bindingIds = revoked.map((r: RoleBinding) => r.id);

      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.userBindingsRevokeAll,
          targetType: AUDIT_TARGETS.user,
          targetId: id,
          tenantId: null,
          before: { revokedCount: revoked.length },
          after: { bindingIds },
        });
      }
      return { revoked: revoked.length, bindingIds };
    });
  }

  async delete(id: string, audit?: AuditRequestContext): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const users = new UsersRepository(tx);
      const bindings = new RoleBindingsRepository(tx);

      const before = await users.findByIdIncludingDeleted(id);
      if (!before) throw new NotFoundError(`user ${id} not found`);
      if (before.deletedAt) {
        // Already soft-deleted: 404 hides the row from callers without
        // confusing them with a 409 on something they probably weren't
        // expecting to see at all.
        throw new NotFoundError(`user ${id} not found`);
      }

      // Drain-before-delete: same pattern as tenant delete. Active bindings
      // means live FGA tuples; refusing here pushes the operator to call
      // revoke-all-bindings first, which the materializer handles.
      const principal = await new PrincipalsRepository(tx).findByUserId(id);
      const blockers: string[] = [];
      if (principal) {
        const activeBindings = await bindings.countActiveForPrincipal(principal.id);
        if (activeBindings > 0) blockers.push(`${activeBindings} active role_binding(s)`);
      }
      if (blockers.length > 0) {
        throw new ConflictError(`cannot delete user: ${blockers.join(', ')}`);
      }

      const after = await users.softDelete(id);
      // findByIdIncludingDeleted above means deletion can only fail to a
      // concurrent delete, which we treat as 404 — the row is gone now.
      if (!after) throw new NotFoundError(`user ${id} not found`);

      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.userDelete,
          targetType: AUDIT_TARGETS.user,
          targetId: id,
          tenantId: null,
          before,
          after,
        });
      }
    });
  }
}
