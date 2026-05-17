import fp from 'fastify-plugin';
import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../services/errors.js';

interface ErrorResponse {
  error: string;
}

const errorHandlerPluginInner: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof Error) {
      handle(err, req, reply);
      return;
    }
    req.log.error({ err }, 'non-Error thrown from handler');
    void reply.code(500).send({ error: 'internal server error' } satisfies ErrorResponse);
  });
};

// fp() unwraps the encapsulation context so the error handler applies to
// every route, not just routes registered inside this plugin's scope.
export const errorHandlerPlugin = fp(errorHandlerPluginInner, { name: 'error-handler' });

function handle(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  // fastify-type-provider-zod surfaces schema validation failures via
  // a FastifyError-shaped object carrying `validation` entries. Format
  // them into the same {error: string} envelope used elsewhere.
  if (hasZodFastifySchemaValidationErrors(err)) {
    const messages = err.validation
      .map(
        (e: { instancePath?: string; message?: string }) =>
          `${e.instancePath && e.instancePath.length > 0 ? e.instancePath : '<root>'}: ${e.message ?? 'invalid'}`,
      )
      .join('; ');
    void reply.code(400).send({ error: messages } satisfies ErrorResponse);
    return;
  }
  if (err instanceof AuthError) {
    void reply.code(401).send({ error: err.message } satisfies ErrorResponse);
    return;
  }
  if (err instanceof ForbiddenError) {
    void reply.code(403).send({ error: err.message } satisfies ErrorResponse);
    return;
  }
  if (err instanceof NotFoundError) {
    void reply.code(404).send({ error: err.message } satisfies ErrorResponse);
    return;
  }
  if (err instanceof ConflictError) {
    void reply.code(409).send({ error: err.message } satisfies ErrorResponse);
    return;
  }
  if (err instanceof ValidationError || err instanceof ZodError) {
    const message = err instanceof ZodError ? formatZod(err) : err.message;
    void reply.code(400).send({ error: message } satisfies ErrorResponse);
    return;
  }

  // Fastify-native errors with a statusCode they set themselves (e.g. payload
  // too large, rate-limit hits).
  const fastifyErr = err as FastifyError;
  if (typeof fastifyErr.statusCode === 'number' && fastifyErr.statusCode < 500) {
    void reply.code(fastifyErr.statusCode).send({ error: err.message } satisfies ErrorResponse);
    return;
  }

  req.log.error({ err }, 'unhandled error');
  void reply.code(500).send({ error: 'internal server error' } satisfies ErrorResponse);
}

function formatZod(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}
