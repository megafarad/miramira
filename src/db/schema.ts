import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { v7 as newId } from 'uuid';

// ────────────────────────────────────────────────────────────────────────────
// tenants
// ────────────────────────────────────────────────────────────────────────────

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    parentId: uuid('parent_id').references((): AnyPgColumn => tenants.id, {
      onDelete: 'restrict',
    }),
    name: text('name').notNull(),
    inherit: boolean('inherit').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('tenants_parent_id_idx').on(t.parentId)],
);

// ────────────────────────────────────────────────────────────────────────────
// users (mirrors Supabase users + holds pre-signup placeholders)
// ────────────────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    supabaseUserId: text('supabase_user_id'),
    emailId: char('email_id', { length: 64 }).notNull(),
    email: text('email').notNull(),
    // Reversible admin shut-off. When set, authentication refuses tokens for
    // this user even if the JWT verifies and bindings still exist.
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    // Soft-delete tombstone. When set, the row is excluded from lookup paths
    // and authentication refuses unconditionally. Kept in place so audit_log
    // rows referencing this user via actor/target still resolve.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('users_email_id_uq').on(t.emailId),
    uniqueIndex('users_supabase_user_id_uq').on(t.supabaseUserId),
    index('users_disabled_at_idx')
      .on(t.disabledAt)
      .where(sql`${t.disabledAt} IS NOT NULL`),
    index('users_deleted_at_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
  ],
);

// ────────────────────────────────────────────────────────────────────────────
// api_keys
// ────────────────────────────────────────────────────────────────────────────

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    keyHash: char('key_hash', { length: 64 }).notNull(),
    keyPrefix: text('key_prefix').notNull(),
    label: text('label').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('api_keys_key_hash_uq').on(t.keyHash),
    index('api_keys_tenant_id_idx').on(t.tenantId),
    index('api_keys_key_prefix_idx').on(t.keyPrefix),
  ],
);

// ────────────────────────────────────────────────────────────────────────────
// principals (polymorphic pointer; FK target for role_bindings)
// ────────────────────────────────────────────────────────────────────────────

export const principalKind = pgEnum('principal_kind', ['user', 'api_key']);

export const principals = pgTable(
  'principals',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    kind: principalKind('kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('principals_user_id_uq').on(t.userId),
    uniqueIndex('principals_api_key_id_uq').on(t.apiKeyId),
    check(
      'principals_exactly_one_of',
      sql`(
        (${t.kind} = 'user' AND ${t.userId} IS NOT NULL AND ${t.apiKeyId} IS NULL)
        OR
        (${t.kind} = 'api_key' AND ${t.apiKeyId} IS NOT NULL AND ${t.userId} IS NULL)
      )`,
    ),
  ],
);

// ────────────────────────────────────────────────────────────────────────────
// scopes
// ────────────────────────────────────────────────────────────────────────────

export const scopes = pgTable(
  'scopes',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('scopes_tenant_id_name_uq').on(t.tenantId, t.name),
    index('scopes_tenant_id_idx').on(t.tenantId),
  ],
);

// ────────────────────────────────────────────────────────────────────────────
// roles
// ────────────────────────────────────────────────────────────────────────────

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    crossesBoundary: boolean('crosses_boundary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('roles_tenant_id_name_uq').on(t.tenantId, t.name),
    index('roles_tenant_id_idx').on(t.tenantId),
  ],
);

// ────────────────────────────────────────────────────────────────────────────
// role_scopes (many-to-many: roles ⇄ scopes)
// ────────────────────────────────────────────────────────────────────────────

export const roleScopes = pgTable(
  'role_scopes',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    scopeId: uuid('scope_id')
      .notNull()
      .references(() => scopes.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.scopeId] }),
    index('role_scopes_scope_id_idx').on(t.scopeId),
  ],
);

// ────────────────────────────────────────────────────────────────────────────
// role_bindings (principal holds role at tenant)
// ────────────────────────────────────────────────────────────────────────────

export const roleBindings = pgTable(
  'role_bindings',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    grantedByPrincipalId: uuid('granted_by_principal_id').references(() => principals.id, {
      onDelete: 'set null',
    }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('role_bindings_principal_role_tenant_uq').on(t.principalId, t.roleId, t.tenantId),
    index('role_bindings_principal_id_idx').on(t.principalId),
    index('role_bindings_tenant_id_idx').on(t.tenantId),
    index('role_bindings_role_id_idx').on(t.roleId),
  ],
);

// ────────────────────────────────────────────────────────────────────────────
// outbox_events (transactional outbox for OpenFGA delivery)
// ────────────────────────────────────────────────────────────────────────────

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }).notNull().defaultNow(),
    // Set when delivery has exceeded maxAttempts. Dead rows are excluded from
    // claimBatch. Clearing dead_at (and resetting attempts/next_retry_at)
    // revives the event for redelivery.
    deadAt: timestamp('dead_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('outbox_events_pending_idx')
      .on(t.nextRetryAt)
      .where(sql`${t.processedAt} IS NULL AND ${t.deadAt} IS NULL`),
    index('outbox_events_dead_idx')
      .on(t.deadAt)
      .where(sql`${t.deadAt} IS NOT NULL`),
    index('outbox_events_aggregate_idx').on(t.aggregateType, t.aggregateId),
  ],
);

// ────────────────────────────────────────────────────────────────────────────
// audit_log (record of every successful mutating API call)
// ────────────────────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    actorPrincipalId: uuid('actor_principal_id').references(() => principals.id, {
      onDelete: 'set null',
    }),
    actorKind: text('actor_kind'),
    requestId: text('request_id').notNull(),
    method: text('method').notNull(),
    route: text('route').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('audit_log_target_idx').on(t.targetType, t.targetId, t.createdAt),
    index('audit_log_actor_idx')
      .on(t.actorPrincipalId, t.createdAt)
      .where(sql`${t.actorPrincipalId} IS NOT NULL`),
    index('audit_log_tenant_idx')
      .on(t.tenantId, t.createdAt)
      .where(sql`${t.tenantId} IS NOT NULL`),
    index('audit_log_created_at_idx').on(t.createdAt),
  ],
);

// ────────────────────────────────────────────────────────────────────────────
// Inferred types
// ────────────────────────────────────────────────────────────────────────────

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type Principal = typeof principals.$inferSelect;
export type NewPrincipal = typeof principals.$inferInsert;
export type Scope = typeof scopes.$inferSelect;
export type NewScope = typeof scopes.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type RoleScope = typeof roleScopes.$inferSelect;
export type NewRoleScope = typeof roleScopes.$inferInsert;
export type RoleBinding = typeof roleBindings.$inferSelect;
export type NewRoleBinding = typeof roleBindings.$inferInsert;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
