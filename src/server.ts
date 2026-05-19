import { buildApp, type AppServices } from './app.js';
import { loadEnv } from './config/env.js';
import { createDb } from './db/client.js';
import { buildMigrationsCheck } from './db/migration-status.js';
import { createFgaClient } from './openfga/client.js';
import { MetricsFgaClient } from './openfga/metrics-client.js';
import { createMetricsRegistry } from './lib/metrics.js';
import { createRemoteJwks } from './lib/jwt.js';
import { withShutdownTimeout } from './lib/shutdown.js';
import { ApiKeysRepository } from './repositories/api-keys.js';
import { AuditLogRepository } from './repositories/audit-log.js';
import { PrincipalsRepository } from './repositories/principals.js';
import { ScopesRepository } from './repositories/scopes.js';
import { UsersRepository } from './repositories/users.js';
import { AuthenticationServiceImpl } from './services/authentication.js';
import { TenantsServiceImpl } from './services/tenants.js';
import { RolesServiceImpl } from './services/roles.js';
import { ScopesServiceImpl } from './services/scopes.js';
import { ApiKeysServiceImpl } from './services/api-keys.js';
import { RoleBindingsServiceImpl } from './services/role-bindings.js';
import { PermissionsServiceImpl } from './services/permissions.js';
import { OutboxAdminServiceImpl } from './services/outbox-admin.js';
import { UserProvisioningServiceImpl } from './services/user-provisioning.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, sql } = createDb(env);
  const metrics = createMetricsRegistry();
  // Decorate the FGA client at the boundary so every downstream consumer
  // (services + readyz) sees the same instrumented instance.
  const fga = new MetricsFgaClient(
    createFgaClient({
      apiUrl: env.OPENFGA_API_URL,
      storeId: env.OPENFGA_STORE_ID,
      authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID,
    }),
    metrics,
  );

  const users = new UsersRepository(db);
  const apiKeysRepo = new ApiKeysRepository(db);
  const principals = new PrincipalsRepository(db);
  const scopesRepo = new ScopesRepository(db);

  const auth = new AuthenticationServiceImpl({
    users,
    apiKeys: apiKeysRepo,
    principals,
    jwks: createRemoteJwks({ jwksUrl: env.SUPABASE_JWKS_URL }),
    jwtIssuer: env.SUPABASE_JWT_ISSUER,
    jwtAudience: env.SUPABASE_JWT_AUDIENCE,
    auditLog: new AuditLogRepository(db),
    // Standalone logger because the Fastify app doesn't exist yet at this
    // point and email-reconciliation warnings need to surface somewhere.
    // Matches the worker process's structured-JSON-via-console pattern.
    logger: {
      warn: (obj: Record<string, unknown>, msg: string): void => {
        console.warn(JSON.stringify({ level: 'warn', msg, ...obj }));
      },
    },
  });

  const services: AppServices = {
    tenants: new TenantsServiceImpl({ db }),
    roles: new RolesServiceImpl({ db }),
    scopes: new ScopesServiceImpl({ db }),
    apiKeys: new ApiKeysServiceImpl({ db }),
    bindings: new RoleBindingsServiceImpl({ db }),
    permissions: new PermissionsServiceImpl({
      fga,
      scopes: scopesRepo,
      principals,
      users,
    }),
    outboxAdmin: new OutboxAdminServiceImpl({ db }),
    userProvisioning: new UserProvisioningServiceImpl({ db }),
  };

  const app = await buildApp({
    env,
    fga,
    db,
    auth,
    services,
    metrics,
    migrationsCheck: buildMigrationsCheck(db),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal, timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'shutdown signal received');
    try {
      await withShutdownTimeout(
        (async () => {
          await app.close();
          await sql.end({ timeout: 5 });
        })(),
        env.SHUTDOWN_TIMEOUT_MS,
        app.log,
        'http server',
      );
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

void main();
