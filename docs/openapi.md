# OpenAPI

miramira generates its OpenAPI 3.1 spec from the same Zod schemas the
runtime uses for request validation — one source of truth for both
documentation and contract enforcement.

## Endpoints

- `GET /openapi.json` — raw spec (public, no auth required)
- `GET /docs` — interactive Swagger UI (public)

Both endpoints sit alongside the rest of the API and are served by the same
Fastify instance, so they reflect the routes actually registered at startup.

## Security schemes

The spec declares two equivalent authentication mechanisms:

- **`bearerAuth`** — HTTP `Authorization: Bearer <jwt>` with a Supabase-
  issued JWT.
- **`apiKeyAuth`** — `X-API-Key: <secret>` header with a miramira-minted
  API key.

When both headers are present, `X-API-Key` wins with no fallback (matches
`src/plugins/auth.ts`). SDK generators that honour the spec's `security`
declarations will let consumers pick either.

## Generating clients

The spec works with any standard OpenAPI tooling. Two common recipes:

### TypeScript fetch client via openapi-typescript

```bash
npx openapi-typescript http://localhost:4000/openapi.json -o types.d.ts
```

Produces typed types you can hand-write fetch calls against, or feed into
`openapi-fetch` for a typed client.

### Multi-language SDK via openapi-generator

```bash
npx @openapitools/openapi-generator-cli generate \
  -i http://localhost:4000/openapi.json \
  -g typescript-axios \
  -o ./client
```

Swap `typescript-axios` for `python`, `go`, `rust`, `java`, etc.

## Extending the spec (for plugin authors)

If you're building custom routes on top of miramira, your routes can opt
into the spec by using the `ZodTypeProvider` and a `schema:` block:

```ts
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { Envelope, ErrorResponse } from 'miramira/schemas/envelopes';

const Body = z.object({ name: z.string() });
const Result = z.object({ id: z.string().uuid(), name: z.string() });

app.withTypeProvider<ZodTypeProvider>().post('/my-thing', {
  schema: {
    tags: ['my-feature'],
    summary: 'Create a thing',
    body: Body,
    response: {
      200: Envelope(Result),
      400: ErrorResponse,
      401: ErrorResponse,
    },
  },
  preHandler: [app.requireAuth],
  handler: async (req) => {
    // req.body is typed as { name: string }
    return { data: { id: 'uuid', name: req.body.name } };
  },
});
```

The route automatically appears in `/openapi.json` and `/docs` with the
declared shape. Use any tag you like — `tags` are free-form strings.

## What's not documented

- **Worker internals** (`src/workers/`) — not HTTP, not in the spec.
- **Webhook receivers** — there are none today; a future phase that adds
  inbound webhooks would document them here.
- **Per-route rate limits** — `@fastify/rate-limit` doesn't surface into
  the spec automatically. The global default (100/min/IP) applies to
  every route except `/healthz` and `/readyz`.
- **`audit_log` table shape** — internal data model, not part of the HTTP
  contract. See [`audit-log.md`](./audit-log.md).

## Wire format notes

- **Timestamps** are ISO 8601 strings (`2024-01-15T12:34:56.789Z`). The
  spec renders these as `{ "type": "string", "format": "date-time" }`.
- **UUIDs** are lowercase hex with dashes; spec uses `format: "uuid"`.
- **Nullable fields** are represented as `nullable: true` per OpenAPI 3.1.
- **Optional request fields** are omitted from `required[]` in the spec;
  callers may omit them entirely or send `undefined`.

## Testing the spec

`test/integration/openapi.test.ts` exercises the served spec against
expected paths, tags, and security schemes. If you add a new route or
change a tag, the test will tell you immediately.
