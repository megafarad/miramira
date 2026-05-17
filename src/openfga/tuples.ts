import { FGA_RELATIONS, FGA_TYPES } from './model.js';

export interface TupleKey {
  user: string;
  relation: string;
  object: string;
}

// "<tenant_uuid>__<scope_uuid>" — encoded as the scope_grant object ID.
// Double underscore (not colon) because OpenFGA reserves ':' as its
// type/id delimiter and rejects it inside an ID.
const SCOPE_GRANT_SEP = '__';

export function scopeGrantObjectId(tenantId: string, scopeId: string): string {
  return `${tenantId}${SCOPE_GRANT_SEP}${scopeId}`;
}

export function parseScopeGrantObjectId(id: string): { tenantId: string; scopeId: string } {
  const idx = id.indexOf(SCOPE_GRANT_SEP);
  if (idx === -1) throw new Error(`malformed scope_grant id: ${id}`);
  return {
    tenantId: id.slice(0, idx),
    scopeId: id.slice(idx + SCOPE_GRANT_SEP.length),
  };
}

export function scopeGrantObject(tenantId: string, scopeId: string): string {
  return `${FGA_TYPES.scopeGrant}:${scopeGrantObjectId(tenantId, scopeId)}`;
}

export function principalObject(principalId: string): string {
  return `${FGA_TYPES.principal}:${principalId}`;
}

export function userObject(userId: string): string {
  return `${FGA_TYPES.user}:${userId}`;
}

export function apiKeyObject(apiKeyId: string): string {
  return `${FGA_TYPES.apiKey}:${apiKeyId}`;
}

/** Tuple granting one scope to one principal at one tenant. */
export function scopeGrantTuple(input: {
  principalId: string;
  scopeId: string;
  tenantId: string;
}): TupleKey {
  return {
    user: principalObject(input.principalId),
    relation: FGA_RELATIONS.scopeGranted,
    object: scopeGrantObject(input.tenantId, input.scopeId),
  };
}

/** Tuple wiring a principal to its underlying user identity. */
export function principalAsUserTuple(principalId: string, userId: string): TupleKey {
  return {
    user: userObject(userId),
    relation: FGA_RELATIONS.principalAs,
    object: principalObject(principalId),
  };
}

/** Tuple wiring a principal to its underlying API key identity. */
export function principalAsApiKeyTuple(principalId: string, apiKeyId: string): TupleKey {
  return {
    user: apiKeyObject(apiKeyId),
    relation: FGA_RELATIONS.principalAs,
    object: principalObject(principalId),
  };
}
