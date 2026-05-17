import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestFga, isFgaReachable } from '../_helpers/fga.js';
import type { FgaClient } from '../../src/openfga/client.js';
import { newId } from '../../src/lib/ids.js';
import {
  principalObject,
  scopeGrantObject,
  scopeGrantTuple,
} from '../../src/openfga/tuples.js';

describe.skipIf(!(await isFgaReachable()))('OpenFgaClient (integration)', () => {
  let fga: FgaClient;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createTestFga();
    fga = ctx.client;
    cleanup = ctx.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it('readinessProbe returns healthy against a live store', async () => {
    const res = await fga.readinessProbe();
    expect(res.healthy).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('writeTuples + check round-trips a positive grant', async () => {
    const principalId = newId();
    const tenantId = newId();
    const scopeId = newId();

    await fga.writeTuples([scopeGrantTuple({ principalId, scopeId, tenantId })]);

    const allowed = await fga.check({
      user: principalObject(principalId),
      relation: 'granted',
      object: scopeGrantObject(tenantId, scopeId),
    });
    expect(allowed).toBe(true);
  });

  it('check returns false for a principal that was never granted', async () => {
    const principalId = newId();
    const tenantId = newId();
    const scopeId = newId();

    const allowed = await fga.check({
      user: principalObject(principalId),
      relation: 'granted',
      object: scopeGrantObject(tenantId, scopeId),
    });
    expect(allowed).toBe(false);
  });

  it('check is scoped to the exact tenant — grant at T1 does not leak to T2', async () => {
    const principalId = newId();
    const t1 = newId();
    const t2 = newId();
    const scopeId = newId();

    await fga.writeTuples([scopeGrantTuple({ principalId, scopeId, tenantId: t1 })]);

    const allowedAtT1 = await fga.check({
      user: principalObject(principalId),
      relation: 'granted',
      object: scopeGrantObject(t1, scopeId),
    });
    const allowedAtT2 = await fga.check({
      user: principalObject(principalId),
      relation: 'granted',
      object: scopeGrantObject(t2, scopeId),
    });
    expect(allowedAtT1).toBe(true);
    expect(allowedAtT2).toBe(false);
  });

  it('deleteTuples removes a grant', async () => {
    const principalId = newId();
    const tenantId = newId();
    const scopeId = newId();
    const tuple = scopeGrantTuple({ principalId, scopeId, tenantId });

    await fga.writeTuples([tuple]);
    expect(
      await fga.check({
        user: principalObject(principalId),
        relation: 'granted',
        object: scopeGrantObject(tenantId, scopeId),
      }),
    ).toBe(true);

    await fga.deleteTuples([tuple]);
    expect(
      await fga.check({
        user: principalObject(principalId),
        relation: 'granted',
        object: scopeGrantObject(tenantId, scopeId),
      }),
    ).toBe(false);
  });

  it('listObjects returns scope_grant objects the principal has access to', async () => {
    const principalId = newId();
    const tenantId = newId();
    const scopeA = newId();
    const scopeB = newId();

    await fga.writeTuples([
      scopeGrantTuple({ principalId, scopeId: scopeA, tenantId }),
      scopeGrantTuple({ principalId, scopeId: scopeB, tenantId }),
    ]);

    const objects = await fga.listObjects({
      user: principalObject(principalId),
      relation: 'granted',
      type: 'scope_grant',
    });
    expect(objects).toContain(scopeGrantObject(tenantId, scopeA));
    expect(objects).toContain(scopeGrantObject(tenantId, scopeB));
  });

  it('handles batches larger than the per-call write cap', async () => {
    const principalId = newId();
    const tenantId = newId();
    // 30 > the WRITE_BATCH_SIZE of 25 — forces a chunked write.
    const scopeIds = Array.from({ length: 30 }, () => newId());
    const tuples = scopeIds.map((scopeId) =>
      scopeGrantTuple({ principalId, scopeId, tenantId }),
    );

    await fga.writeTuples(tuples);

    const objects = await fga.listObjects({
      user: principalObject(principalId),
      relation: 'granted',
      type: 'scope_grant',
    });
    expect(objects.length).toBeGreaterThanOrEqual(30);
  });
});
