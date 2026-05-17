import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

// Serves the OpenAPI 3.1 spec at /openapi.json and an interactive Swagger UI
// at /docs. Both endpoints are public (no auth) — the spec describes shape,
// not data, and standard OSS practice is to make the contract discoverable.
//
// Per-route schemas declared via Zod on the route's `schema:` block are
// converted to JSON Schema by jsonSchemaTransform and rendered automatically.

const openapiPluginInner: FastifyPluginAsync = async (app) => {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'miramira',
        version: '0.1.0',
        description:
          'Standalone relationship-based authorization service. Hierarchical multi-tenancy, ' +
          'roles, scopes, transactional outbox for OpenFGA materialization, audit logging.',
      },
      servers: [{ url: '/', description: 'Current host' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Supabase-issued JWT in Authorization: Bearer <token>',
          },
          apiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            description:
              'miramira-issued API key in X-API-Key header. Wins over Bearer when both are present.',
          },
        },
      },
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // @fastify/swagger exposes `app.swagger()` to get the generated spec but
  // doesn't serve it at a well-known path. Serve it at /openapi.json so
  // OSS users and SDK generators can fetch it without hunting for the
  // swagger-ui internal route (/docs/json).
  app.get('/openapi.json', async () => app.swagger());
};

export const openapiPlugin = fp(openapiPluginInner, { name: 'openapi' });
