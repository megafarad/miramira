import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { ApiKeysRepo } from '../repositories/api-keys.js';
import type { PrincipalsRepo } from '../repositories/principals.js';
import type { UsersRepo } from '../repositories/users.js';
import type { Principal } from '../db/schema.js';
import { AuthError } from './errors.js';

export interface AuthenticationService {
  authenticateJwt(token: string): Promise<Principal>;
  authenticateApiKey(secret: string): Promise<Principal>;
}

export interface AuthenticationServiceDeps {
  users: UsersRepo;
  apiKeys: ApiKeysRepo;
  principals: PrincipalsRepo;
  jwks: JWTVerifyGetKey;
  jwtIssuer: string;
  jwtAudience: string;
}

export class AuthenticationServiceImpl implements AuthenticationService {
  constructor(private readonly deps: AuthenticationServiceDeps) {}

  async authenticateJwt(token: string): Promise<Principal> {
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
      const backfilled = await this.deps.users.backfillSupabaseId(user.id, sub);
      if (backfilled) user = backfilled;
    }

    return this.deps.principals.ensureForUser(user.id);
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
