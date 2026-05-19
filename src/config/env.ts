import { existsSync } from 'node:fs';
import { z } from 'zod';

// Load .env once at module init so every entrypoint that imports this module
// (server, worker, scripts, tests) sees the same env. CI / production are
// expected to inject vars directly and have no .env file.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().url(),

    OPENFGA_API_URL: z.string().url(),
    // Populated by `npm run openfga:bootstrap`. Required at app startup so
    // permission checks pin to a known model version.
    OPENFGA_STORE_ID: z.string().min(1),
    OPENFGA_AUTHORIZATION_MODEL_ID: z.string().min(1),

    SUPABASE_JWKS_URL: z.string().url(),
    SUPABASE_JWT_ISSUER: z.string(),
    SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),

    // Standard Webhooks shared secret for POST /webhooks/supabase. When
    // unset, the route isn't registered (dev-friendly default; required only
    // when the Supabase project actually points an Auth Hook at this server).
    // Accepts the raw secret or the conventional `whsec_<base64>` form —
    // the verifier strips the prefix.
    SUPABASE_WEBHOOK_SECRET: z.string().min(1).optional(),

    // Comma-separated list of origins allowed by CORS. In production the env
    // must set this explicitly; in development we fall back to common local-dev
    // frontend ports.
    CORS_ALLOWED_ORIGINS: z
      .string()
      .optional()
      .transform(
        (raw) =>
          raw
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean) ?? [],
      ),

    // When set, `npm run db:seed` upserts this user, ensures a principal, and
    // idempotently binds the admin role at the master tenant. Without it, every
    // API endpoint 403s because nobody holds any scopes.
    BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),

    // Hard ceiling on graceful shutdown. After SIGTERM we drain in-flight
    // HTTP requests and the worker's current batch — but if anything hangs
    // (e.g. an OpenFGA call that never returns) we force-exit non-zero rather
    // than sit until the orchestrator SIGKILLs us. k8s' default
    // terminationGracePeriodSeconds is 30; this matches.
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    // Worker process exposes /metrics on this port. The HTTP server exposes
    // /metrics on the main PORT — workers need their own listener because they
    // are a separate process. Unauthenticated; bind behind a private network.
    METRICS_PORT: z.coerce.number().int().positive().default(9090),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.CORS_ALLOWED_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'CORS_ALLOWED_ORIGINS must be set in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
