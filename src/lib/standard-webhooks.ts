// Standard Webhooks signature verification (https://www.standardwebhooks.com).
//
// Producers (Supabase Auth Hooks, Svix, others) sign the payload with
// HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`. The signature header
// carries one or more `v1,<base64>` entries to support key rotation; any
// match is acceptable. The id and timestamp are passed as separate headers so
// the producer can prove freshness.
//
// This module is pure: no Fastify, no logging. The route module reads the
// headers + raw body, calls verify, and maps the result to an HTTP code.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyInput {
  id: string;
  /** Unix seconds, as sent by the producer. */
  timestamp: string;
  /** Raw value of the `webhook-signature` header. */
  signature: string;
  /** Raw request body bytes. */
  body: Buffer;
  /** Shared secret. The `whsec_` prefix is accepted and stripped. */
  secret: string;
  /** Override for tests. Defaults to Date.now(). */
  now?: number;
  /** Replay tolerance in seconds either side. Defaults to 5 minutes. */
  toleranceSeconds?: number;
}

export type VerifyResult = { valid: true } | { valid: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | 'missing_header'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'invalid_signature_format'
  | 'signature_mismatch';

const DEFAULT_TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = 'whsec_';

export function verifyStandardWebhook(input: VerifyInput): VerifyResult {
  if (!input.id || !input.timestamp || !input.signature) {
    return { valid: false, reason: 'missing_header' };
  }

  const tsSeconds = Number(input.timestamp);
  if (!Number.isFinite(tsSeconds)) {
    return { valid: false, reason: 'invalid_timestamp' };
  }
  const now = input.now ?? Date.now();
  const tolerance = (input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
  if (Math.abs(now - tsSeconds * 1000) > tolerance) {
    return { valid: false, reason: 'stale_timestamp' };
  }

  // Header is whitespace-separated `v1,<base64>` entries. Tolerate trailing
  // whitespace and ignore unknown version prefixes (forward-compat).
  const entries = input.signature
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) {
    return { valid: false, reason: 'invalid_signature_format' };
  }

  const secretBytes = decodeSecret(input.secret);
  const expected = createHmac('sha256', secretBytes)
    .update(`${input.id}.${input.timestamp}.${input.body.toString('utf8')}`)
    .digest();

  for (const entry of entries) {
    const [version, sig] = entry.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(sig, 'base64');
    } catch {
      continue;
    }
    if (provided.length !== expected.length) continue;
    if (timingSafeEqual(provided, expected)) return { valid: true };
  }

  return { valid: false, reason: 'signature_mismatch' };
}

function decodeSecret(secret: string): Buffer {
  const stripped = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  // Standard Webhooks recommends base64-encoded keys. If the operator
  // provides raw bytes (no base64), treat the string as UTF-8 — most HMAC
  // implementations accept either and the test for valid base64 is
  // ambiguous (any string is "valid" base64 to Node). Heuristic: try
  // base64 first; if the round-trip doesn't match, fall back to UTF-8.
  const decoded = Buffer.from(stripped, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') === stripped.replace(/=+$/, '')) {
    return decoded;
  }
  return Buffer.from(stripped, 'utf8');
}
