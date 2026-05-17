// Wire-format DTOs for OpenAPI documentation.
//
// Timestamps use z.date() so the handler return types (Drizzle returns Date
// objects) typecheck against these schemas. jsonSchemaTransform renders
// z.date() as `{ type: 'string', format: 'date-time' }` in the generated
// OpenAPI spec, which matches the actual wire format (JSON serialization
// converts Date → ISO string).
//
// We intentionally do NOT install fastify-type-provider-zod's serializerCompiler,
// so these schemas are not validated at runtime.

import { z } from 'zod';

const Timestamp = z.date();

export const TenantDto = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  name: z.string(),
  inherit: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const RoleDto = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  crossesBoundary: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const ScopeDto = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

// GET /roles/:id — role plus the scopes it grants.
export const RoleWithScopesDto = z.object({
  role: RoleDto,
  scopes: z.array(ScopeDto),
});

// Public projection of an api_key row (no key_hash, no secret).
export const ApiKeyDto = z.object({
  id: z.string().uuid(),
  label: z.string(),
  tenantId: z.string().uuid(),
  keyPrefix: z.string(),
  createdByUserId: z.string().uuid().nullable(),
  lastUsedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});

// POST /api-keys — same as ApiKeyDto plus the one-time secret and the
// principalId so the caller can immediately grant role bindings to it.
export const CreatedApiKeyDto = ApiKeyDto.extend({
  principalId: z.string().uuid(),
  secret: z.string().describe('Shown exactly once. Cannot be recovered.'),
}).omit({ lastUsedAt: true, revokedAt: true, createdByUserId: true });

export const RoleBindingDto = z.object({
  id: z.string().uuid(),
  principalId: z.string().uuid(),
  roleId: z.string().uuid(),
  tenantId: z.string().uuid(),
  grantedByPrincipalId: z.string().uuid().nullable(),
  grantedAt: Timestamp,
  expiresAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

// GET /me
export const MeDto = z.object({
  principalId: z.string().uuid(),
  kind: z.enum(['user', 'api_key']),
  userId: z.string().uuid().nullable(),
  apiKeyId: z.string().uuid().nullable(),
});

// One entry inside GET /me/permissions
export const PermissionScopeDto = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
});

export const MePermissionsDto = z.object({
  tenantId: z.string().uuid(),
  scopes: z.array(PermissionScopeDto),
});

// POST /check and each entry in POST /check/batch
export const CheckResultDto = z.object({
  allowed: z.boolean(),
});

export const CheckBatchResultDto = z.object({
  results: z.array(CheckResultDto),
});
