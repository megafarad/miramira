import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

// The request-envelope half of an audit entry. Services receive this and add
// the domain half (action, target, before, after) at insert time.
export interface AuditRequestContext {
  actorPrincipalId: string | null;
  actorKind: string | null;
  requestId: string;
  method: string;
  route: string;
  ip: string | null;
  userAgent: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Build an AuditRequestContext from the current request. Called by routes
     * just before invoking a mutating service method, e.g.:
     *
     *   await deps.tenants.update(id, patch, req.auditContext());
     *
     * The service inserts the audit row inside the same db.transaction()
     * as the business write, so either both commit or neither does.
     */
    auditContext(): AuditRequestContext;
  }
}

function pickHeader(h: string | string[] | undefined): string | null {
  return typeof h === 'string' && h.length > 0 ? h : null;
}

const auditPluginInner: FastifyPluginAsync = async (app) => {
  app.decorateRequest(
    'auditContext',
    function buildAuditContext(this: FastifyRequest): AuditRequestContext {
      return {
        actorPrincipalId: this.principal?.id ?? null,
        actorKind: this.principal?.kind ?? null,
        requestId: this.id,
        method: this.method,
        // routeOptions.url is the Fastify route template ('/tenants/:id');
        // falls back to the literal URL if the request didn't match a route
        // (shouldn't happen for handler-invoked code, but defensive).
        route: this.routeOptions?.url ?? this.url,
        ip: this.ip ?? null,
        userAgent: pickHeader(this.headers['user-agent']),
      };
    },
  );
};

export const auditPlugin = fp(auditPluginInner, { name: 'audit' });
