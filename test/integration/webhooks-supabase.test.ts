import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { closeTestDb, getTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, TEST_WEBHOOK_SECRET, type TestApp } from '../_helpers/app.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { auditLog } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';

const reachable = (await isDbReachable()) && (await isFgaReachable());

// Build a Standard Webhooks-signed POST that the receiver will accept.
function signedPayload(
  body: object,
  opts: { eventId?: string; nowSec?: number } = {},
): {
  payload: string;
  headers: Record<string, string>;
} {
  const eventId = opts.eventId ?? 'evt_test_1';
  const ts = String(opts.nowSec ?? Math.floor(Date.now() / 1000));
  const payload = JSON.stringify(body);
  const stripped = TEST_WEBHOOK_SECRET.startsWith('whsec_')
    ? TEST_WEBHOOK_SECRET.slice('whsec_'.length)
    : TEST_WEBHOOK_SECRET;
  const sig = createHmac('sha256', Buffer.from(stripped, 'base64'))
    .update(`${eventId}.${ts}.${payload}`)
    .digest('base64');
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'webhook-id': eventId,
      'webhook-timestamp': ts,
      'webhook-signature': `v1,${sig}`,
    },
  };
}

function beforeUserCreated(email: string): object {
  return {
    metadata: {
      uuid: '8b34dcdd-9df1-4c10-850a-b3277c653040',
      time: new Date().toISOString(),
      name: 'before-user-created',
      ip_address: '127.0.0.1',
    },
    user: {
      // Intentional: id is the unreliable placeholder Supabase sends. The
      // route ignores it.
      id: '00000000-0000-0000-0000-000000000000',
      email,
      phone: '',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      identities: [],
      is_anonymous: false,
    },
  };
}

describe.skipIf(!reachable)('routes: POST /webhooks/supabase', () => {
  let t: TestApp;
  let users: UsersRepository;
  let principals: PrincipalsRepository;

  beforeAll(async () => {
    t = await buildTestApp();
    const { db } = getTestDb();
    users = new UsersRepository(db);
    principals = new PrincipalsRepository(db);
  });
  beforeEach(async () => {
    await t.resetDb();
  });
  afterAll(async () => {
    await t.cleanup();
    await closeTestDb();
  });

  it('provisions a new user + principal on before-user-created, returns 204', async () => {
    const { payload, headers } = signedPayload(beforeUserCreated('alice@example.com'));
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/supabase',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe('');

    const user = await users.findByEmail('alice@example.com');
    expect(user).toBeDefined();
    expect(user!.supabaseUserId).toBeNull();
    const principal = await principals.findByUserId(user!.id);
    expect(principal).toBeDefined();
  });

  it('is idempotent on retry: no duplicate rows', async () => {
    const body = beforeUserCreated('bob@example.com');
    const first = signedPayload(body, { eventId: 'evt_dup_1' });
    const second = signedPayload(body, { eventId: 'evt_dup_2' });

    const r1 = await t.app.inject({
      method: 'POST',
      url: '/webhooks/supabase',
      headers: first.headers,
      payload: first.payload,
    });
    const r2 = await t.app.inject({
      method: 'POST',
      url: '/webhooks/supabase',
      headers: second.headers,
      payload: second.payload,
    });
    expect(r1.statusCode).toBe(204);
    expect(r2.statusCode).toBe(204);

    const u = await users.findByEmail('bob@example.com');
    expect(u).toBeDefined();
    // Audit log: one row for create, one no-op row for the retry.
    const { db } = getTestDb();
    const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, u!.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === 'user.provision')).toBe(true);
  });

  it('does not overwrite supabase_user_id on a pre-existing row', async () => {
    // Simulate a user who has already authenticated once and had their sub
    // backfilled by services/authentication.ts.
    const created = await users.upsertByEmailId('carol@example.com');
    await users.backfillSupabaseId(created.id, 'sb-existing-sub');

    const { payload, headers } = signedPayload(beforeUserCreated('carol@example.com'));
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/supabase',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(204);

    const after = await users.findByEmail('carol@example.com');
    expect(after?.supabaseUserId).toBe('sb-existing-sub');
  });

  it('returns 401 on a wrong signature', async () => {
    const { payload, headers } = signedPayload(beforeUserCreated('dave@example.com'));
    const tampered = { ...headers, 'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAA' };
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/supabase',
      headers: tampered,
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 on a stale timestamp', async () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 10 * 60;
    const { payload, headers } = signedPayload(beforeUserCreated('eve@example.com'), {
      nowSec: tenMinutesAgo,
    });
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/supabase',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when the payload does not match the expected envelope', async () => {
    const { headers } = signedPayload({});
    const garbage = JSON.stringify({ junk: true });
    // Re-sign the bad body so signature passes; we want the schema check to
    // be the failure point.
    const ts = headers['webhook-timestamp']!;
    const id = headers['webhook-id']!;
    const stripped = TEST_WEBHOOK_SECRET.slice('whsec_'.length);
    const sig = createHmac('sha256', Buffer.from(stripped, 'base64'))
      .update(`${id}.${ts}.${garbage}`)
      .digest('base64');
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/supabase',
      headers: { ...headers, 'webhook-signature': `v1,${sig}` },
      payload: garbage,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 204 for an unsupported metadata.name (no-op)', async () => {
    const body = beforeUserCreated('frank@example.com');
    (body as { metadata: { name: string } }).metadata.name = 'send-email';
    const { payload, headers } = signedPayload(body);
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/supabase',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(204);
    // Nothing got provisioned.
    expect(await users.findByEmail('frank@example.com')).toBeUndefined();
  });

  it('writes an audit row with actorKind null (webhook is unauthenticated)', async () => {
    const { payload, headers } = signedPayload(beforeUserCreated('grace@example.com'));
    const res = await t.app.inject({
      method: 'POST',
      url: '/webhooks/supabase',
      headers,
      payload,
    });
    expect(res.statusCode).toBe(204);

    const u = await users.findByEmail('grace@example.com');
    expect(u).toBeDefined();
    const { db } = getTestDb();
    const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, u!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('user.provision');
    expect(rows[0]?.actorPrincipalId).toBeNull();
    expect(rows[0]?.actorKind).toBeNull();
    expect(rows[0]?.route).toBe('/webhooks/supabase');
  });
});
