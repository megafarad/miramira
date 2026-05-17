import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { healthRoutes } from './routes/health.js';
import { meRoutes, mePermissionsRoutes } from './routes/me.js';
import { tenantsRoutes } from './routes/tenants.js';
import { rolesRoutes } from './routes/roles.js';
import { scopesRoutes } from './routes/scopes.js';
import { apiKeysRoutes } from './routes/api-keys.js';
import { roleBindingsRoutes } from './routes/role-bindings.js';
import { checkRoutes } from './routes/check.js';
import type { Env } from './config/env.js';
import type { FgaClient } from './openfga/client.js';
import type { Database } from './db/client.js';
import type { AuthenticationService } from './services/authentication.js';
import type { TenantsService } from './services/tenants.js';
import type { RolesService } from './services/roles.js';
import type { ScopesService } from './services/scopes.js';
import type { ApiKeysService } from './services/api-keys.js';
import type { RoleBindingsService } from './services/role-bindings.js';
import type { PermissionsService } from './services/permissions.js';
import { auditPlugin } from './plugins/audit.js';
import { authPlugin } from './plugins/auth.js';
import { authorizePlugin } from './plugins/authorize.js';
import { corsPlugin } from './plugins/cors.js';
import { errorHandlerPlugin } from './plugins/errorHandler.js';
import { loggingPlugin } from './plugins/logging.js';
import { openapiPlugin } from './plugins/openapi.js';
import { rateLimitPlugin } from './plugins/rateLimit.js';

export interface AppServices {
  tenants: TenantsService;
  roles: RolesService;
  scopes: ScopesService;
  apiKeys: ApiKeysService;
  bindings: RoleBindingsService;
  permissions: PermissionsService;
}

export interface BuildAppOptions {
  env: Env;
  fastify?: FastifyServerOptions;
  // Optional downstreams. Production wires all via server.ts; tests can omit
  // any to keep the surface small.
  fga?: FgaClient;
  db?: Database;
  auth?: AuthenticationService;
  // When provided alongside `auth`, registers the full Phase-7 surface:
  // authorize plugin + 6 resource route modules. When omitted, only /me
  // is registered behind requireAuth.
  services?: AppServices;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: opts.env.LOG_LEVEL,
      ...(opts.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } } }
        : {}),
    },
    disableRequestLogging: opts.env.NODE_ENV === 'test',
    ...opts.fastify,
  });

  // Use Zod schemas declared in route `schema:` blocks for both request
  // validation and response serialization. The serializer compiler is required
  // alongside response schemas — without it, Fastify falls back to fast-json-
  // stringify which doesn't understand Zod schemas. Dates serialize to ISO
  // strings as JSON.stringify expects; z.date() accepts the in-memory Date.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);
  await app.register(corsPlugin, { env: opts.env });
  await app.register(rateLimitPlugin);
  await app.register(sensible);
  await app.register(loggingPlugin);
  await app.register(auditPlugin);
  await app.register(openapiPlugin);

  if (opts.auth) {
    await app.register(authPlugin, { service: opts.auth });
    await app.register(meRoutes);

    if (opts.services) {
      await app.register(authorizePlugin, { service: opts.services.permissions });
      await app.register(mePermissionsRoutes({ permissions: opts.services.permissions }));
      await app.register(tenantsRoutes({ tenants: opts.services.tenants }));
      await app.register(
        rolesRoutes({ roles: opts.services.roles, permissions: opts.services.permissions }),
      );
      await app.register(
        scopesRoutes({ scopes: opts.services.scopes, permissions: opts.services.permissions }),
      );
      await app.register(
        apiKeysRoutes({
          apiKeys: opts.services.apiKeys,
          permissions: opts.services.permissions,
        }),
      );
      await app.register(
        roleBindingsRoutes({
          bindings: opts.services.bindings,
          permissions: opts.services.permissions,
        }),
      );
      await app.register(checkRoutes({ permissions: opts.services.permissions }));
    }
  }

  await app.register(healthRoutes({ fga: opts.fga, db: opts.db }));

  return app;
}
