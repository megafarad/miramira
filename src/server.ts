import { buildApp, type AppServices } from './app.js';
import { loadEnv } from './config/env.js';
import { createDb } from './db/client.js';
import { createFgaClient } from './openfga/client.js';
import { createRemoteJwks } from './lib/jwt.js';
import { ApiKeysRepository } from './repositories/api-keys.js';
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

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, sql } = createDb(env);
  const fga = createFgaClient({
    apiUrl: env.OPENFGA_API_URL,
    storeId: env.OPENFGA_STORE_ID,
    authorizationModelId: env.OPENFGA_AUTHORIZATION_MODEL_ID,
  });

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
  };

  const app = await buildApp({ env, fga, db, auth, services });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received');
    try {
      await app.close();
      await sql.end({ timeout: 5 });
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
