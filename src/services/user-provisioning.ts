// Idempotent provisioning of a local users row + principal in response to a
// Supabase Auth Hook. Called by the webhook receiver; can also be invoked
// directly by future admin/invite flows.
//
// Note: we intentionally do NOT set `supabase_user_id` here. Supabase's
// `before-user-created` hook fires with a dummy user.id, so we wait for the
// first JWT-authenticated request to backfill it via the existing
// authentication.ts lookup chain (sub → email → upsert + backfill).

import type { Database } from '../db/client.js';
import { UsersRepository, type User } from '../repositories/users.js';
import { PrincipalsRepository, type Principal } from '../repositories/principals.js';
import { AuditLogRepository } from '../repositories/audit-log.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';

export interface ProvisionInput {
  email: string;
}

export interface ProvisionResult {
  user: User;
  principal: Principal;
  /** True iff this call inserted a brand-new users row. */
  created: boolean;
}

export interface UserProvisioningService {
  provisionFromAuthHook(
    input: ProvisionInput,
    audit?: AuditRequestContext,
  ): Promise<ProvisionResult>;
}

export interface UserProvisioningServiceDeps {
  db: Database;
}

export class UserProvisioningServiceImpl implements UserProvisioningService {
  constructor(private readonly deps: UserProvisioningServiceDeps) {}

  async provisionFromAuthHook(
    input: ProvisionInput,
    audit?: AuditRequestContext,
  ): Promise<ProvisionResult> {
    return this.deps.db.transaction(async (tx) => {
      const users = new UsersRepository(tx);
      const principals = new PrincipalsRepository(tx);

      // Detect whether this is a brand-new local row so the audit entry can
      // distinguish "created" vs "no-op". findByEmail also hashes the email,
      // matching what upsertByEmailId uses as its conflict target.
      const before = await users.findByEmail(input.email);
      const user = await users.upsertByEmailId(input.email);
      const principal = await principals.ensureForUser(user.id);
      const created = before === undefined;

      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.userProvision,
          targetType: AUDIT_TARGETS.user,
          targetId: user.id,
          tenantId: null,
          before: before ?? null,
          after: user,
        });
      }

      return { user, principal, created };
    });
  }
}
