// Canonical action names recorded in audit_log.action. Plugin authors building
// custom mutating endpoints are free to use their own strings — these are
// conventions, not enforced. Keeping them centralised here gives consumers a
// single import for the actions miramira itself emits.
export const AUDIT_ACTIONS = {
  tenantCreate: 'tenant.create',
  tenantUpdate: 'tenant.update',
  roleCreate: 'role.create',
  roleUpdate: 'role.update',
  roleScopeAdd: 'role.scope_add',
  roleScopeRemove: 'role.scope_remove',
  scopeCreate: 'scope.create',
  scopeUpdate: 'scope.update',
  apiKeyCreate: 'api_key.create',
  apiKeyRevoke: 'api_key.revoke',
  roleBindingCreate: 'role_binding.create',
  roleBindingRevoke: 'role_binding.revoke',
  outboxRevive: 'outbox.revive',
  outboxPurge: 'outbox.purge',
} as const;

// Canonical target types — match audit_log.target_type.
export const AUDIT_TARGETS = {
  tenant: 'tenant',
  role: 'role',
  scope: 'scope',
  apiKey: 'api_key',
  roleBinding: 'role_binding',
  outboxEvent: 'outbox_event',
} as const;
