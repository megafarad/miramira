import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';

const ALG = 'RS256';

export interface TestJwtContext {
  jwks: JWTVerifyGetKey;
  issuer: string;
  audience: string;
  sign(claims: {
    sub: string;
    email?: string;
    expiresIn?: string | number;
    issuer?: string;
    audience?: string;
  }): Promise<string>;
}

export async function createTestJwtContext(opts?: {
  issuer?: string;
  audience?: string;
}): Promise<TestJwtContext> {
  const issuer = opts?.issuer ?? 'https://test.local/auth/v1';
  const audience = opts?.audience ?? 'authenticated';

  const { publicKey, privateKey } = await generateKeyPair(ALG);
  const publicJwk: JWK = await exportJWK(publicKey);
  publicJwk.alg = ALG;
  publicJwk.use = 'sig';

  const jwks = createLocalJWKSet({ keys: [publicJwk] });

  const sign: TestJwtContext['sign'] = async (claims) => {
    const jwt = new SignJWT(claims.email !== undefined ? { email: claims.email } : {})
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt()
      .setSubject(claims.sub)
      .setIssuer(claims.issuer ?? issuer)
      .setAudience(claims.audience ?? audience)
      .setExpirationTime(claims.expiresIn ?? '5m');
    return jwt.sign(privateKey);
  };

  return { jwks, issuer, audience, sign };
}
