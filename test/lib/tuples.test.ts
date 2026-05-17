import { describe, expect, it } from 'vitest';
import {
  apiKeyObject,
  parseScopeGrantObjectId,
  principalAsApiKeyTuple,
  principalAsUserTuple,
  principalObject,
  scopeGrantObject,
  scopeGrantObjectId,
  scopeGrantTuple,
  userObject,
} from '../../src/openfga/tuples.js';

describe('tuples', () => {
  const T = '019e2e5d-3ef7-777c-962e-50e26e4d3da3';
  const S = '019e2e5d-3ef8-75ad-85c6-b6dc1132be09';
  const P = '019e2e5d-3ef8-75ad-85c6-b28fded51022';
  const U = '019e2e5d-3ef8-75ad-85c6-c12fa6120a81';
  const K = '019e2e5d-3ef8-75ad-85c6-c445d6415e02';

  it('encodes scope_grant object IDs as <tenant>__<scope>', () => {
    expect(scopeGrantObjectId(T, S)).toBe(`${T}__${S}`);
    expect(scopeGrantObject(T, S)).toBe(`scope_grant:${T}__${S}`);
  });

  it('parseScopeGrantObjectId is the inverse of scopeGrantObjectId', () => {
    const id = scopeGrantObjectId(T, S);
    expect(parseScopeGrantObjectId(id)).toEqual({ tenantId: T, scopeId: S });
  });

  it('builds object refs with the type prefix', () => {
    expect(principalObject(P)).toBe(`principal:${P}`);
    expect(userObject(U)).toBe(`user:${U}`);
    expect(apiKeyObject(K)).toBe(`api_key:${K}`);
  });

  it('scopeGrantTuple shape: principal granted scope_grant', () => {
    expect(scopeGrantTuple({ principalId: P, scopeId: S, tenantId: T })).toEqual({
      user: `principal:${P}`,
      relation: 'granted',
      object: `scope_grant:${T}__${S}`,
    });
  });

  it('principalAs* tuples have the identity object as the user side', () => {
    expect(principalAsUserTuple(P, U)).toEqual({
      user: `user:${U}`,
      relation: 'as',
      object: `principal:${P}`,
    });
    expect(principalAsApiKeyTuple(P, K)).toEqual({
      user: `api_key:${K}`,
      relation: 'as',
      object: `principal:${P}`,
    });
  });
});
