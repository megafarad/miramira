import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AuthenticationService } from '../services/authentication.js';
import type { Principal } from '../db/schema.js';
import { AuthError } from '../services/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
  interface FastifyInstance {
    requireAuth: preHandlerAsyncHookHandler;
  }
}

export interface AuthPluginOptions {
  service: AuthenticationService;
}

// fastify-plugin wrapping is required so decorators set here are visible to
// routes registered in sibling/child scopes.
const authPluginInner: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const auth = opts.service;

  const requireAuth: preHandlerAsyncHookHandler = async (req: FastifyRequest) => {
    // X-API-Key wins when both headers are present. There is intentionally NO
    // fallback to the Bearer token if the key is invalid or revoked — a leaked
    // key plus a valid JWT must not silently upgrade.
    const apiKey = pickHeader(req.headers['x-api-key']);
    if (apiKey) {
      req.principal = await auth.authenticateApiKey(apiKey);
      return;
    }

    const authHeader = pickHeader(req.headers.authorization);
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AuthError('missing credentials (X-API-Key or Authorization: Bearer <jwt>)');
    }
    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) throw new AuthError('empty Bearer token');
    req.principal = await auth.authenticateJwt(token);
  };

  app.decorate('requireAuth', requireAuth);
};

// Headers in Fastify are typed `string | string[] | undefined`. Treat arrays
// as malformed and ignore them — these headers are single-valued in practice.
function pickHeader(h: string | string[] | undefined): string | undefined {
  return typeof h === 'string' && h.length > 0 ? h : undefined;
}

export const authPlugin = fp(authPluginInner, { name: 'auth' });
