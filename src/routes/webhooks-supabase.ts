// Supabase Auth Hook receiver.
//
// Verifies the Standard Webhooks signature, parses the payload, and
// dispatches recognized event types to the provisioning service. Returns
// 204 on success or recognized no-op; 401 on signature failure; 400 on
// malformed payload; 5xx (via thrown error) on transient internal error so
// Supabase retries.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { UserProvisioningService } from '../services/user-provisioning.js';
import { verifyStandardWebhook } from '../lib/standard-webhooks.js';
import { ErrorResponse } from '../schemas/envelopes.js';

// Supabase wraps the hook-specific user record in a `user` object alongside
// metadata. Other fields on `user` (id, identities, app_metadata, etc.) are
// passthrough'd because Supabase adds fields over time and we don't want a
// schema change to break verification.
//
// Important: `user.id` is intentionally NOT consumed. Supabase populates it
// with a dummy value for the `before-user-created` hook (the row doesn't
// exist yet). The real `supabase_user_id` is backfilled from the JWT on the
// user's first authenticated request — see services/authentication.ts.
const WebhookPayload = z
  .object({
    metadata: z.object({
      uuid: z.string(),
      time: z.string(),
      name: z.string(),
      ip_address: z.string().optional(),
    }),
    user: z
      .object({
        email: z.string().email(),
      })
      .passthrough(),
  })
  .passthrough();

const TAG = 'webhooks';

// Header names per the Standard Webhooks spec.
const H_ID = 'webhook-id';
const H_TIMESTAMP = 'webhook-timestamp';
const H_SIGNATURE = 'webhook-signature';

export interface WebhooksSupabaseRoutesDeps {
  userProvisioning: UserProvisioningService;
  /** Pre-shared secret from env. Must be non-empty if this module is registered. */
  secret: string;
}

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

export const webhooksSupabaseRoutes = (deps: WebhooksSupabaseRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    // Encapsulation scope so the JSON parser override doesn't leak to the
    // rest of the API. Inside this scope, application/json bodies are
    // captured as Buffer and JSON-parsed manually; rawBody is stashed on
    // the request for the HMAC check.
    await app.register(async (scope) => {
      scope.removeContentTypeParser('application/json');
      scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
        (req as RawBodyRequest).rawBody = body as Buffer;
        try {
          const parsed: unknown =
            body.length === 0 ? {} : JSON.parse((body as Buffer).toString('utf8'));
          done(null, parsed);
        } catch (err) {
          done(err as Error);
        }
      });

      const r = scope.withTypeProvider<ZodTypeProvider>();

      r.post(
        '/webhooks/supabase',
        {
          schema: {
            tags: [TAG],
            summary: 'Supabase Auth Hook receiver (Standard Webhooks signed)',
            response: {
              204: z.null(),
              400: ErrorResponse,
              401: ErrorResponse,
            },
          },
        },
        async (req, reply) => {
          const raw = (req as RawBodyRequest).rawBody;
          if (!raw) {
            // Defensive: the scoped parser should always populate rawBody.
            return reply.code(400).send({ error: 'missing request body' });
          }

          const verification = verifyStandardWebhook({
            id: headerString(req, H_ID) ?? '',
            timestamp: headerString(req, H_TIMESTAMP) ?? '',
            signature: headerString(req, H_SIGNATURE) ?? '',
            body: raw,
            secret: deps.secret,
          });
          if (!verification.valid) {
            req.log.warn({ reason: verification.reason }, 'supabase webhook rejected');
            return reply.code(401).send({ error: 'webhook signature verification failed' });
          }

          const parsed = WebhookPayload.safeParse(req.body);
          if (!parsed.success) {
            return reply.code(400).send({ error: 'unrecognized webhook payload shape' });
          }

          const { metadata, user } = parsed.data;
          if (metadata.name === 'before-user-created') {
            const result = await deps.userProvisioning.provisionFromAuthHook(
              { email: user.email },
              req.auditContext(),
            );
            req.log.info(
              {
                eventId: metadata.uuid,
                event: metadata.name,
                userId: result.user.id,
                created: result.created,
              },
              'supabase webhook handled',
            );
          } else {
            // Unrecognized event: 204 so Supabase doesn't retry forever.
            // Logged so operators see what events the project is sending
            // that we haven't implemented yet.
            req.log.info(
              { eventId: metadata.uuid, event: metadata.name },
              'supabase webhook event type not handled; ignoring',
            );
          }

          return reply.code(204).send(null);
        },
      );
    });
  };
};

function headerString(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}
