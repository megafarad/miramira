// OpenFGA authorization model.
//
// Design note (denormalized): rather than encoding tenant hierarchy +
// inherit/crosses_boundary semantics inside the FGA model, we materialize the
// "effective" (principal, scope, tenant) triples as `scope_grant` tuples.
// The service layer is responsible for computing the effective expansion when
// role bindings or tenant inheritance changes, and emitting the corresponding
// FGA writes via the outbox worker (Phase 5).
//
// Trade-off:
//   - Reads (Check) are O(1): a single tuple lookup.
//   - Writes fan out: granting one binding may produce many tuples
//     (one per (scope, effective-tenant) pair).
//   - Inheritance changes require recomputation in the service layer.
//
// scope_grant object IDs follow the format: "<tenant_uuid>:<scope_uuid>".

import type { WriteAuthorizationModelRequest } from '@openfga/sdk';

export const AUTHORIZATION_MODEL: WriteAuthorizationModelRequest = {
  schema_version: '1.1',
  type_definitions: [
    {
      type: 'user',
      relations: {},
    },
    {
      type: 'api_key',
      relations: {},
    },
    {
      type: 'principal',
      relations: {
        as: { this: {} },
      },
      metadata: {
        relations: {
          as: {
            directly_related_user_types: [{ type: 'user' }, { type: 'api_key' }],
          },
        },
      },
    },
    {
      type: 'scope_grant',
      relations: {
        granted: { this: {} },
      },
      metadata: {
        relations: {
          granted: {
            directly_related_user_types: [{ type: 'principal' }],
          },
        },
      },
    },
  ],
};

// Object type names (string literals from the model). Use these instead of
// scattering string literals across the codebase.
export const FGA_TYPES = {
  user: 'user',
  apiKey: 'api_key',
  principal: 'principal',
  scopeGrant: 'scope_grant',
} as const;

export const FGA_RELATIONS = {
  principalAs: 'as',
  scopeGranted: 'granted',
} as const;
