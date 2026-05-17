import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

export interface RemoteJwksConfig {
  jwksUrl: string;
}

/**
 * Build a key-resolver suitable for `jose.jwtVerify`. Uses `jose`'s built-in
 * caching + retry — fetched once on first use, refreshed every ~10 minutes,
 * retries on cache miss. Production wiring.
 *
 * Tests should use `jose.createLocalJWKSet` directly with a locally generated
 * key set; do not stub this function.
 */
export function createRemoteJwks(config: RemoteJwksConfig): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(config.jwksUrl));
}
