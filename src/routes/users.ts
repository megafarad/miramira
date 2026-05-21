// Principal lifecycle (user-side). Lets a global admin disable, re-enable,
// bulk-revoke bindings, or soft-delete a user.
//
// Authorization: user rows aren't tenant-scoped, so every scope check
// resolves to MASTER_TENANT_ID. Read endpoints require `users:read`; the
// mutating endpoints require `users:write`. Both scopes ship with the
// system `admin` role.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { UsersService } from '../services/users.js';
import { Envelope, ErrorResponse } from '../schemas/envelopes.js';
import { RevokeAllBindingsResultDto, UserDto } from '../schemas/dtos.js';
import { MASTER_TENANT_ID } from '../db/seeds/system-ids.js';

const UserIdParams = z.object({ id: z.string().uuid() });

const TAG = 'users';

// Users are system-level resources; scope checks always target the master
// tenant. Centralised so all routes use the same resolver.
const tenantOfRequest = (): string => MASTER_TENANT_ID;

function toDto(u: {
  id: string;
  email: string;
  supabaseUserId: string | null;
  disabledAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): z.infer<typeof UserDto> {
  return {
    id: u.id,
    email: u.email,
    supabaseUserId: u.supabaseUserId,
    disabledAt: u.disabledAt,
    deletedAt: u.deletedAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export interface UsersRoutesDeps {
  users: UsersService;
}

export const usersRoutes = (deps: UsersRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get(
      '/users/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Get a user by id (includes disabled and soft-deleted rows)',
          params: UserIdParams,
          response: {
            200: Envelope(UserDto),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('users:read', tenantOfRequest)],
      },
      async (req) => {
        const user = await deps.users.get(req.params.id);
        return { data: toDto(user) };
      },
    );

    r.post(
      '/users/:id/disable',
      {
        schema: {
          tags: [TAG],
          summary:
            'Disable a user. Blocks JWT authentication immediately; bindings are left intact.',
          params: UserIdParams,
          response: {
            200: Envelope(UserDto),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
            409: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('users:write', tenantOfRequest)],
      },
      async (req) => {
        const user = await deps.users.disable(req.params.id, req.auditContext());
        return { data: toDto(user) };
      },
    );

    r.post(
      '/users/:id/enable',
      {
        schema: {
          tags: [TAG],
          summary: 'Re-enable a previously disabled user.',
          params: UserIdParams,
          response: {
            200: Envelope(UserDto),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
            409: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('users:write', tenantOfRequest)],
      },
      async (req) => {
        const user = await deps.users.enable(req.params.id, req.auditContext());
        return { data: toDto(user) };
      },
    );

    r.post(
      '/users/:id/revoke-all-bindings',
      {
        schema: {
          tags: [TAG],
          summary:
            "Revoke every active role_binding owned by the user's principal. Refuses with 409 above 500 active bindings — page through manually instead.",
          params: UserIdParams,
          response: {
            200: Envelope(RevokeAllBindingsResultDto),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
            409: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('users:write', tenantOfRequest)],
      },
      async (req) => {
        const result = await deps.users.revokeAllBindings(req.params.id, req.auditContext());
        return { data: result };
      },
    );

    r.delete(
      '/users/:id',
      {
        schema: {
          tags: [TAG],
          summary:
            'Soft-delete a user. Refuses with 409 if the user still has active role_bindings.',
          params: UserIdParams,
          response: {
            204: z.null(),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
            409: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('users:write', tenantOfRequest)],
      },
      async (req, reply) => {
        await deps.users.delete(req.params.id, req.auditContext());
        return reply.code(204).send(null);
      },
    );
  };
};
