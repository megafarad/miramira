import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'mrm_';
const KEY_BYTES = 32; // 256 bits of entropy
const HASH_PREFIX_LEN = 12; // characters of the public-visible prefix (incl. mrm_)

export interface MintedApiKey {
  /** Full secret shown to the user exactly once. */
  secret: string;
  /** Short prefix safe to store/display for UI lookups. */
  prefix: string;
  /** SHA-256 hex of the secret. Stored in `api_keys.key_hash`. */
  hash: string;
}

export function mintApiKey(): MintedApiKey {
  const body = randomBytes(KEY_BYTES).toString('base64url');
  const secret = `${KEY_PREFIX}${body}`;
  return {
    secret,
    prefix: secret.slice(0, HASH_PREFIX_LEN),
    hash: hashApiKey(secret),
  };
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
