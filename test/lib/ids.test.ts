import { describe, expect, it } from 'vitest';
import { newId } from '../../src/lib/ids.js';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  it('produces a UUID v7 (version nibble = 7, variant nibble in 8/9/a/b)', () => {
    const id = newId();
    expect(id).toMatch(UUID_V7_RE);
  });

  it('produces monotonically non-decreasing values when called in sequence', () => {
    const ids = Array.from({ length: 50 }, () => newId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('produces unique values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });
});
