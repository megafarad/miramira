import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PermissionsService } from '../services/permissions.js';
import { Envelope, ErrorResponse } from '../schemas/envelopes.js';
import { CheckBatchResultDto, CheckResultDto } from '../schemas/dtos.js';

const SubjectSchema = z.union([
  z.object({ sub: z.string().min(1) }).strict(),
  z.object({ email: z.string().email() }).strict(),
  z.object({ apiKeyId: z.string().uuid() }).strict(),
]);

const CheckBody = z.object({
  tenantId: z.string().uuid(),
  scope: z.string().min(1).max(255),
  subject: SubjectSchema.optional(),
});

const MAX_BATCH = 100;

const CheckBatchBody = z.object({
  checks: z.array(CheckBody).min(1).max(MAX_BATCH),
});

const TAG = 'check';

export interface CheckRoutesDeps {
  permissions: PermissionsService;
}

export const checkRoutes = (deps: CheckRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post(
      '/check',
      {
        schema: {
          tags: [TAG],
          summary:
            'Check whether a principal holds a scope at a tenant. Self-check by default; ' +
            'pass `subject` (with permissions:check) to check on behalf of someone else.',
          body: CheckBody,
          response: {
            200: Envelope(CheckResultDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          async (req) => {
            const body = req.body as z.infer<typeof CheckBody> | undefined;
            if (body?.subject) {
              await deps.permissions.assertScope(
                req.principal.id,
                body.tenantId,
                'permissions:check',
              );
            }
          },
        ],
      },
      async (req) => {
        const result = await deps.permissions.check({
          requesterPrincipalId: req.principal.id,
          tenantId: req.body.tenantId,
          scope: req.body.scope,
          subject: req.body.subject,
        });
        return { data: result };
      },
    );

    r.post(
      '/check/batch',
      {
        schema: {
          tags: [TAG],
          summary: 'Run up to 100 checks in one request. Results returned in input order.',
          body: CheckBatchBody,
          response: {
            200: Envelope(CheckBatchResultDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: app.requireAuth,
      },
      async (req) => {
        const results: { allowed: boolean }[] = [];
        // Per-check authz: subject-bearing entries need permissions:check at
        // their tenantId. The first 403 short-circuits the entire batch.
        for (const check of req.body.checks) {
          if (check.subject) {
            await deps.permissions.assertScope(
              req.principal.id,
              check.tenantId,
              'permissions:check',
            );
          }
          results.push(
            await deps.permissions.check({
              requesterPrincipalId: req.principal.id,
              tenantId: check.tenantId,
              scope: check.scope,
              subject: check.subject,
            }),
          );
        }
        return { data: { results } };
      },
    );
  };
};
