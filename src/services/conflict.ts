import { ConflictError } from './errors.js';

// Postgres "unique_violation" error code. Surfaces on duplicate inserts and
// on updates that would collide with another row's unique key.
const PG_UNIQUE_VIOLATION = '23505';

function hasCode(err: unknown, code: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === code;
}

// drizzle-orm 1.0 wraps the postgres-js error in a DrizzleError; the original
// Postgres error (with its `code`) is on `err.cause`. Walk the cause chain so
// we tolerate either flat or wrapped errors.
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    if (hasCode(cur, PG_UNIQUE_VIOLATION)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Convert a Postgres unique-violation thrown by `fn` into a ConflictError
 * (→ 409 via the route error handler). Any other error is re-thrown.
 * Keeps the Postgres-error-code knowledge in one place rather than scattering
 * try/catch blocks across services.
 */
export async function wrapConflict<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(message);
    throw err;
  }
}
