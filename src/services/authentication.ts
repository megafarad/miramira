import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { ApiKeysRepo } from '../repositories/api-keys.js';
import type { PrincipalsRepo } from '../repositories/principals.js';
import type { UsersRepo } from '../repositories/users.js';
import type { AuditLogRepo } from '../repositories/audit-log.js';
import type { Principal, User } from '../db/schema.js';
import { AuthError } from './errors.js';
import { emailId as computeEmailId } from '../lib/email.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';

export interface AuthLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface AuthenticationService {
  authenticateJwt(token: string, audit?: AuditRequestContext): Promise<Principal>;
  authenticateApiKey(secret: string): Promise<Principal>;
}

export interface AuthenticationServiceDeps {
  users: UsersRepo;
  apiKeys: ApiKeysRepo;
  principals: PrincipalsRepo;
  jwks: JWTVerifyGetKey;
  jwtIssuer: string;
  jwtAudience: string;
  /**
   * When provided, the auth flow will write a `user.email_change` audit row
   * whenever a JWT carries an email different from the local row. Optional so
   * tests that don't care about audit can omit it.
   */
  auditLog?: AuditLogRepo;
  /** Used only for the soft-fail warning when email reconciliation hits a unique conflict. */
  logger?: AuthLogger;
}

export class AuthenticationServiceImpl implements AuthenticationService {
  constructor(private readonly deps: AuthenticationServiceDeps) {}

  async authenticateJwt(token: string, audit?: AuditRequestContext): Promise<Principal> {
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.deps.jwks, {
        issuer: this.deps.jwtIssuer,
        audience: this.deps.jwtAudience,
      });
      payload = verified.payload;
    } catch {
      // Don't leak verifier internals (expired vs bad sig vs wrong iss-aud).
      // A 401 is a 401 from the client's perspective.
      throw new AuthError('invalid token');
    }

    const sub = payload.sub;
    if (!sub) throw new AuthError('token missing sub claim');
    const email = typeof payload.email === 'string' ? payload.email : undefined;

    // 1. Direct lookup by Supabase sub.
    let user = await this.deps.users.findBySupabaseId(sub);

    // 2. Fall back to email_id (bridges the "before user created" webhook gap).
    if (!user && email) {
      user = await this.deps.users.findByEmail(email);
      if (user) {
        const backfilled = await this.deps.users.backfillSupabaseId(user.id, sub);
        if (backfilled) user = backfilled;
      }
    }

    // 3. Auto-provision if neither lookup hit. JWT auth may arrive before
    //    any webhook fires; upsert+backfill is idempotent.
    if (!user) {
      if (!email) throw new AuthError('cannot resolve user: token has no email claim');
      user = await this.deps.users.upsertByEmailId(email);
      // upsertByEmailId can collide on `users_email_id_uq` with a soft-deleted
      // row and return that row. Gate BEFORE backfill — otherwise we'd write a
      // fresh `supabase_user_id` onto a deleted user, undoing soft-delete's
      // sub-clearing.
      if (user.deletedAt) throw new AuthError('user disabled');
      const backfilled = await this.deps.users.backfillSupabaseId(user.id, sub);
      if (backfilled) user = backfilled;
    }

    // 3b. Disabled users are blocked regardless of resolution path. Soft-
    //     deleted users only reach here via path 3, which gates them above;
    //     paths 1 and 2 use repo reads that filter `deleted_at IS NULL`.
    if (user.disabledAt) throw new AuthError('user disabled');

    // 4. Reconcile email: when the JWT's email claim differs from what we have
    //    on file, refresh both `email` and `email_id` so subsequent lookups
    //    (and display) reflect the user's current Supabase identity. Skipped
    //    when path #3 just provisioned the row (email already matches by
    //    construction). Best-effort: a uniqueness conflict means another
    //    local user already owns the new email; we log and keep going.
    const principal = await this.deps.principals.ensureForUser(user.id);
    if (email && email !== user.email) {
      await this.reconcileEmail(user, email, principal, audit);
    }
    return principal;
  }

  private async reconcileEmail(
    user: User,
    newEmail: string,
    principal: Principal,
    audit?: AuditRequestContext,
  ): Promise<void> {
    // Cheap short-circuit: raw inequality might be whitespace/case-only
    // difference that hashes the same. Only spend a write if the canonical
    // hashes actually diverge.
    if (computeEmailId(newEmail) === user.emailId) return;

    const updated = await this.deps.users.updateEmail(user.id, newEmail);
    if (!updated) {
      this.deps.logger?.warn(
        { userId: user.id, oldEmail: user.email, newEmail },
        'jwt email differs from local row but another user already owns it; keeping stale email',
      );
      return;
    }

    if (this.deps.auditLog && audit) {
      try {
        await this.deps.auditLog.insert({
          ...audit,
          actorPrincipalId: principal.id,
          actorKind: principal.kind,
          action: AUDIT_ACTIONS.userEmailChange,
          targetType: AUDIT_TARGETS.user,
          targetId: user.id,
          tenantId: null,
          before: { email: user.email },
          after: { email: updated.email },
        });
      } catch (err) {
        // Audit failure must not break authentication.
        this.deps.logger?.warn(
          { userId: user.id, err: String(err) },
          'failed to write user.email_change audit row',
        );
      }
    }
  }

  async authenticateApiKey(secret: string): Promise<Principal> {
    const key = await this.deps.apiKeys.findActiveBySecret(secret);
    if (!key) throw new AuthError('invalid or expired API key');

    // Fire-and-forget: telemetry must not block the request and must not
    // surface its errors. If the DB write throws, the auth still succeeded.
    void this.deps.apiKeys.touchLastUsed(key.id).catch(() => undefined);

    return this.deps.principals.ensureForApiKey(key.id);
  }
}
