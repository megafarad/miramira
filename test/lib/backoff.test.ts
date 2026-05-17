import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKOFF, nextDelayMs, nextRetryAt } from '../../src/lib/backoff.js';

describe('nextDelayMs', () => {
  it('returns ~base on first failure', () => {
    // attempts=1 => 2^0 * base = base, ±20% jitter
    const noJitter = () => 0.5; // 0.5 -> 2*0.5 - 1 = 0 offset
    expect(nextDelayMs(1, DEFAULT_BACKOFF, noJitter)).toBe(DEFAULT_BACKOFF.baseMs);
  });

  it('doubles each attempt up to the cap', () => {
    const noJitter = () => 0.5;
    expect(nextDelayMs(1, DEFAULT_BACKOFF, noJitter)).toBe(1_000);
    expect(nextDelayMs(2, DEFAULT_BACKOFF, noJitter)).toBe(2_000);
    expect(nextDelayMs(3, DEFAULT_BACKOFF, noJitter)).toBe(4_000);
    expect(nextDelayMs(4, DEFAULT_BACKOFF, noJitter)).toBe(8_000);
  });

  it('clamps to maxMs', () => {
    const noJitter = () => 0.5;
    // huge attempt count => raw would be astronomical, capped at 5min
    expect(nextDelayMs(50, DEFAULT_BACKOFF, noJitter)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it('applies jitter within the configured band', () => {
    // random() = 1.0 -> +max offset; random() = 0.0 -> -max offset
    const cfg = { baseMs: 1_000, factor: 2, maxMs: 60_000, jitterRatio: 0.2 };
    expect(nextDelayMs(1, cfg, () => 1.0)).toBe(1_200);
    expect(nextDelayMs(1, cfg, () => 0.0)).toBe(800);
  });

  it('never returns negative', () => {
    // If jitter band somehow exceeds the value (shouldn't with ratio<1), still floor at 0
    const cfg = { baseMs: 1, factor: 2, maxMs: 60_000, jitterRatio: 2.0 };
    expect(nextDelayMs(1, cfg, () => 0.0)).toBeGreaterThanOrEqual(0);
  });
});

describe('nextRetryAt', () => {
  it('returns a Date in the future', () => {
    const now = new Date('2026-05-15T12:00:00Z');
    const result = nextRetryAt(
      1,
      DEFAULT_BACKOFF,
      () => now,
      () => 0.5,
    );
    expect(result.getTime()).toBe(now.getTime() + DEFAULT_BACKOFF.baseMs);
  });
});
