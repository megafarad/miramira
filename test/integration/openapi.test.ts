import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { tags?: string[]; summary?: string }>>;
  components?: {
    securitySchemes?: Record<string, { type: string }>;
  };
}

describe.skipIf(!reachable)('OpenAPI spec', () => {
  let t: TestApp;
  let spec: OpenApiSpec;

  beforeAll(async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    spec = res.json<OpenApiSpec>();
  });
  afterAll(async () => {
    await t.cleanup();
    await closeTestDb();
  });

  it('serves a well-formed OpenAPI 3.x document', () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe('miramira');
    expect(spec.info.version).toBeTruthy();
  });

  it('documents the expected resource paths', () => {
    const paths = Object.keys(spec.paths);
    expect(paths).toContain('/tenants');
    expect(paths).toContain('/tenants/{id}');
    expect(paths).toContain('/tenants/{tenantId}/roles');
    expect(paths).toContain('/tenants/{tenantId}/scopes');
    expect(paths).toContain('/roles/{id}');
    expect(paths).toContain('/scopes/{id}');
    expect(paths).toContain('/api-keys');
    expect(paths).toContain('/api-keys/{id}');
    expect(paths).toContain('/role-bindings');
    expect(paths).toContain('/role-bindings/{id}');
    expect(paths).toContain('/check');
    expect(paths).toContain('/check/batch');
    expect(paths).toContain('/me');
    expect(paths).toContain('/me/permissions');
  });

  it('groups operations under expected tags', () => {
    const tagSet = new Set<string>();
    for (const operations of Object.values(spec.paths)) {
      for (const op of Object.values(operations)) {
        for (const tag of op.tags ?? []) tagSet.add(tag);
      }
    }
    expect(tagSet).toContain('tenants');
    expect(tagSet).toContain('roles');
    expect(tagSet).toContain('scopes');
    expect(tagSet).toContain('api-keys');
    expect(tagSet).toContain('role-bindings');
    expect(tagSet).toContain('check');
    expect(tagSet).toContain('me');
  });

  it('declares both Bearer and API-key security schemes', () => {
    const schemes = spec.components?.securitySchemes ?? {};
    expect(schemes.bearerAuth?.type).toBe('http');
    expect(schemes.apiKeyAuth?.type).toBe('apiKey');
  });

  it('serves the Swagger UI HTML at /docs', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/docs/static/index.html',
    });
    // Swagger-UI's index.html lives at /docs/static/index.html in @fastify/swagger-ui.
    // Either the html OR a 302 to it is acceptable.
    expect([200, 302]).toContain(res.statusCode);
  });

  it('POST /tenants documents body and 200 response', () => {
    const op = spec.paths['/tenants']?.post as
      | { requestBody?: unknown; responses?: Record<string, unknown> }
      | undefined;
    expect(op).toBeDefined();
    expect(op?.requestBody).toBeDefined();
    expect(op?.responses?.['200']).toBeDefined();
  });

  it('POST /check/batch documents batch shape', () => {
    const op = spec.paths['/check/batch']?.post as
      | { requestBody?: unknown; responses?: Record<string, unknown> }
      | undefined;
    expect(op).toBeDefined();
    expect(op?.requestBody).toBeDefined();
  });
});
