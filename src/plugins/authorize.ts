import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { PermissionsService } from '../services/permissions.js';

export type TenantIdResolver = (req: FastifyRequest) => string | Promise<string>;

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Build a preHandler that throws ForbiddenError (→ 403) unless the
     * authenticated principal holds `scope` at the tenant returned by
     * `getTenantId(req)`. The resolver runs AFTER Fastify validation, so it
     * may safely access `req.body`, `req.params`, and `req.query`.
     */
    requireScope(scope: string, getTenantId: TenantIdResolver): preHandlerAsyncHookHandler;
  }
}

export interface AuthorizePluginOptions {
  service: PermissionsService;
}

// fastify-plugin wrapping is required so the decorator is visible to routes
// registered in sibling/child scopes (same reason as auth.ts).
const authorizePluginInner: FastifyPluginAsync<AuthorizePluginOptions> = async (app, opts) => {
  const permissions = opts.service;

  app.decorate('requireScope', (scope: string, getTenantId: TenantIdResolver) => {
    const handler: preHandlerAsyncHookHandler = async (req) => {
      const tenantId = await getTenantId(req);
      await permissions.assertScope(req.principal.id, tenantId, scope);
    };
    return handler;
  });
};

export const authorizePlugin = fp(authorizePluginInner, { name: 'authorize' });
