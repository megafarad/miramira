// Builds a fully-wired test Fastify instance: real DB (via test pool), real
// FGA (fresh store per file), services, auth + authorize plugins, and all
// Phase-7 routes. Provides convenience helpers for minting an admin JWT.
//
// Usage:
//   const t = await buildTestApp();
//   afterAll(() => t.cleanup());
//   beforeEach(() => t.resetDb());
//   const admin = await t.adminToken();   // user bound to admin@master + worker run
//   await t.app.inject({ method: 'POST', url: '/tenants', headers: { authorization: `Bearer ${admin.token}` }, payload: ... });

import type { FastifyInstance } from 'fastify';
import { buildApp, type AppServices } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import type { FgaClient } from '../../src/openfga/client.js';
import type { Database } from '../../src/db/client.js';

import { ApiKeysRepository } from '../../src/repositories/api-keys.js';
import { OutboxRepository } from '../../src/repositories/outbox.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { ScopesRepository } from '../../src/repositories/scopes.js';
import { UsersRepository } from '../../src/repositories/users.js';

import { AuthenticationServiceImpl } from '../../src/services/authentication.js';
import { TenantsServiceImpl } from '../../src/services/tenants.js';
import { RolesServiceImpl } from '../../src/services/roles.js';
import { ScopesServiceImpl } from '../../src/services/scopes.js';
import { ApiKeysServiceImpl } from '../../src/services/api-keys.js';
import { RoleBindingsServiceImpl } from '../../src/services/role-bindings.js';
import { PermissionsServiceImpl } from '../../src/services/permissions.js';
import { GrantMaterializerImpl } from '../../src/services/grant-materializer.js';

import { OutboxDispatcherImpl } from '../../src/workers/dispatcher.js';
import { OutboxWorker } from '../../src/workers/worker.js';

import { MASTER_TENANT_ID, SYSTEM_ROLE_ADMIN_ID } from '../../src/db/seeds/system-ids.js';

import { getTestDb, resetDb } from './db.js';
import { createTestFga } from './fga.js';
import { createTestJwtContext, type TestJwtContext } from './fake-jwt.js';

export interface AdminToken {
  email: string;
  sub: string;
  token: string;
  userId: string;
  principalId: string;
}

export interface TestApp {
  app: FastifyInstance;
  fga: FgaClient;
  db: Database;
  worker: OutboxWorker;
  services: AppServices;
  jwt: TestJwtContext;
  resetDb(): Promise<void>;
  cleanup(): Promise<void>;
  /**
   * Create (or upsert) a user, ensure their principal, mint a Supabase-style
   * JWT. Does NOT grant any scopes — caller is just authenticated.
   */
  ensureUser(opts?: {
    email?: string;
    sub?: string;
  }): Promise<{ email: string; sub: string; token: string; userId: string; principalId: string }>;
  /**
   * Insert an active binding (principal, admin role, tenantId) and run the
   * worker once so FGA tuples are materialized. Idempotent enough for tests:
   * if a binding already exists, just re-runs the worker.
   */
  grantAdminAt(principalId: string, tenantId?: string): Promise<void>;
  /**
   * Shortcut: ensureUser + grantAdminAt(master). Returns the materialized
   * token + ids for use in route requests.
   */
  adminToken(opts?: { email?: string; sub?: string }): Promise<AdminToken>;
}

let counter = 0;

export async function buildTestApp(): Promise<TestApp> {
  const fgaCtx = await createTestFga();
  const { db } = getTestDb();
  const jwt = await createTestJwtContext();

  const users = new UsersRepository(db);
  const apiKeysRepo = new ApiKeysRepository(db);
  const principals = new PrincipalsRepository(db);
  const scopesRepo = new ScopesRepository(db);
  const outbox = new OutboxRepository(db);

  const auth = new AuthenticationServiceImpl({
    users,
    apiKeys: apiKeysRepo,
    principals,
    jwks: jwt.jwks,
    jwtIssuer: jwt.issuer,
    jwtAudience: jwt.audience,
  });

  const services: AppServices = {
    tenants: new TenantsServiceImpl({ db }),
    roles: new RolesServiceImpl({ db }),
    scopes: new ScopesServiceImpl({ db }),
    apiKeys: new ApiKeysServiceImpl({ db }),
    bindings: new RoleBindingsServiceImpl({ db }),
    permissions: new PermissionsServiceImpl({
      fga: fgaCtx.client,
      scopes: scopesRepo,
      principals,
      users,
    }),
  };

  const env: Env = {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://unused',
    OPENFGA_API_URL: 'http://unused.local',
    OPENFGA_STORE_ID: fgaCtx.storeId,
    OPENFGA_AUTHORIZATION_MODEL_ID: fgaCtx.modelId,
    SUPABASE_JWKS_URL: 'http://unused.local',
    SUPABASE_JWT_ISSUER: jwt.issuer,
    SUPABASE_JWT_AUDIENCE: jwt.audience,
    CORS_ALLOWED_ORIGINS: [],
    SHUTDOWN_TIMEOUT_MS: 30_000,
  };

  const app = await buildApp({
    env,
    fga: fgaCtx.client,
    db,
    auth,
    services,
  });
  await app.ready();

  const materializer = new GrantMaterializerImpl({ db, fga: fgaCtx.client });
  const dispatcher = new OutboxDispatcherImpl({ materializer });
  const worker = new OutboxWorker({ outbox, dispatcher });

  const t: TestApp = {
    app,
    fga: fgaCtx.client,
    db,
    worker,
    services,
    jwt,

    async resetDb() {
      await resetDb();
    },

    async cleanup() {
      await app.close();
      await fgaCtx.cleanup();
    },

    async ensureUser({ email, sub } = {}) {
      counter += 1;
      const resolvedEmail = email ?? `user-${Date.now()}-${counter}@test.local`;
      const resolvedSub = sub ?? `sub-${Date.now()}-${counter}`;
      const user = await users.upsertByEmailId(resolvedEmail);
      await users.backfillSupabaseId(user.id, resolvedSub);
      const principal = await principals.ensureForUser(user.id);
      const token = await jwt.sign({ sub: resolvedSub, email: resolvedEmail });
      return {
        email: resolvedEmail,
        sub: resolvedSub,
        token,
        userId: user.id,
        principalId: principal.id,
      };
    },

    async grantAdminAt(principalId: string, tenantId: string = MASTER_TENANT_ID) {
      // Create binding only if a fresh active one doesn't already exist;
      // otherwise the unique index would throw. (principal, role, tenant) is
      // unique, so a single page with limit=10 is more than enough.
      const page = await services.bindings.page({ tenantId, principalId }, { limit: 10 });
      const hasAdmin = page.items.some((b) => b.roleId === SYSTEM_ROLE_ADMIN_ID && !b.revokedAt);
      if (!hasAdmin) {
        await services.bindings.create({
          principalId,
          roleId: SYSTEM_ROLE_ADMIN_ID,
          tenantId,
        });
      }
      // Drain the outbox so FGA tuples land before tests run requests.
      // Loop until no claims, in case prior setup also enqueued events.
      for (;;) {
        const res = await worker.runOnce();
        if (res.claimed === 0) break;
      }
    },

    async adminToken(opts) {
      const user = await this.ensureUser(opts);
      await this.grantAdminAt(user.principalId);
      return {
        email: user.email,
        sub: user.sub,
        token: user.token,
        userId: user.userId,
        principalId: user.principalId,
      };
    },
  };

  return t;
}
