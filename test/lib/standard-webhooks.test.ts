import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyStandardWebhook } from '../../src/lib/standard-webhooks.js';

const SECRET = 'whsec_dGVzdC1zZWNyZXQ='; // 'test-secret' base64
const BODY = Buffer.from('{"hello":"world"}', 'utf8');
const EVENT_ID = 'evt_01HZX0K2D9X';
// Frozen "now" used for deterministic timestamp arithmetic.
const NOW_MS = 1_750_000_000_000;
const NOW_TS = String(Math.floor(NOW_MS / 1000));

function sign(secret: string, id: string, timestamp: string, body: Buffer): string {
  const stripped = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(stripped, 'base64');
  const sig = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body.toString('utf8')}`)
    .digest('base64');
  return `v1,${sig}`;
}

describe('verifyStandardWebhook', () => {
  it('accepts a correctly signed request', () => {
    const result = verifyStandardWebhook({
      id: EVENT_ID,
      timestamp: NOW_TS,
      signature: sign(SECRET, EVENT_ID, NOW_TS, BODY),
      body: BODY,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects when any required header is empty', () => {
    const r1 = verifyStandardWebhook({
      id: '',
      timestamp: NOW_TS,
      signature: sign(SECRET, EVENT_ID, NOW_TS, BODY),
      body: BODY,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(r1).toEqual({ valid: false, reason: 'missing_header' });

    const r2 = verifyStandardWebhook({
      id: EVENT_ID,
      timestamp: NOW_TS,
      signature: '',
      body: BODY,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(r2).toEqual({ valid: false, reason: 'missing_header' });
  });

  it('rejects non-numeric timestamps', () => {
    const result = verifyStandardWebhook({
      id: EVENT_ID,
      timestamp: 'not-a-number',
      signature: sign(SECRET, EVENT_ID, NOW_TS, BODY),
      body: BODY,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ valid: false, reason: 'invalid_timestamp' });
  });

  it('rejects stale timestamps beyond the tolerance', () => {
    const staleTs = String(Math.floor(NOW_MS / 1000) - 10 * 60); // 10 min ago
    const result = verifyStandardWebhook({
      id: EVENT_ID,
      timestamp: staleTs,
      signature: sign(SECRET, EVENT_ID, staleTs, BODY),
      body: BODY,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
  });

  it('rejects timestamps too far in the future', () => {
    const futureTs = String(Math.floor(NOW_MS / 1000) + 10 * 60);
    const result = verifyStandardWebhook({
      id: EVENT_ID,
      timestamp: futureTs,
      signature: sign(SECRET, EVENT_ID, futureTs, BODY),
      body: BODY,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ valid: false, reason: 'stale_timestamp' });
  });

  it('rejects signatures computed with a different secret', () => {
    const bad = sign('whsec_d3Jvbmctc2VjcmV0', EVENT_ID, NOW_TS, BODY); // 'wrong-secret'
    const result = verifyStandardWebhook({
      id: EVENT_ID,
      timestamp: NOW_TS,
      signature: bad,
      body: BODY,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rejects signatures computed over a different body', () => {
    const sig = sign(SECRET, EVENT_ID, NOW_TS, Buffer.from('{"other":"body"}', 'utf8'));
    const result = verifyStandardWebhook({
      id: EVENT_ID,
      timestamp: NOW_TS,
      signature: sig,
      body: BODY,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('accepts a multi-value signature header when any v1 entry matches', () => {
    // First entry is wrong, second matches — verifier should still accept.
    const wrong = 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const right = sign(SECRET, EVENT_ID, NOW_TS, BODY);
    const result = verifyStandardWebhook({
      id: EVENT_ID,
      timestamp: NOW_TS,
      signature: `${wrong} ${right}`,
      body: BODY,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result.valid).toBe(true);
  });

  it('ignores unknown signature versions and finds a matching v1', () => {
    const right = sign(SECRET, EVENT_ID, NOW_TS, BODY);
    const result = verifyStandardWebhook({
      id: EVENT_ID,
      timestamp: NOW_TS,
      signature: `v999,bogus ${right}`,
      body: BODY,
      secret: SECRET,
      now: NOW_MS,
    });
    expect(result.valid).toBe(true);
  });

  it('strips the whsec_ prefix from the configured secret', () => {
    const withPrefix = SECRET;
    const withoutPrefix = SECRET.slice('whsec_'.length);
    const sig = sign(withoutPrefix, EVENT_ID, NOW_TS, BODY);
    const result = verifyStandardWebhook({
      id: EVENT_ID,
      timestamp: NOW_TS,
      signature: sig,
      body: BODY,
      secret: withPrefix,
      now: NOW_MS,
    });
    expect(result.valid).toBe(true);
  });
});
