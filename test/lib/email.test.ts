import { describe, expect, it } from 'vitest';
import { emailId, normalizeEmail } from '../../src/lib/email.js';

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
  });

  it('does not perform Gmail dot stripping', () => {
    expect(normalizeEmail('a.b@gmail.com')).toBe('a.b@gmail.com');
  });

  it('does not perform plus-tag stripping', () => {
    expect(normalizeEmail('alice+work@example.com')).toBe('alice+work@example.com');
  });
});

describe('emailId', () => {
  it('returns a 64-char lowercase hex string', () => {
    const id = emailId('alice@example.com');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across casing and whitespace variants of the same email', () => {
    const a = emailId('  Alice@Example.com ');
    const b = emailId('alice@example.com');
    expect(a).toBe(b);
  });

  it('changes when local-part differs (no Gmail dot magic)', () => {
    expect(emailId('a.b@gmail.com')).not.toBe(emailId('ab@gmail.com'));
  });

  it('changes when plus-tag differs', () => {
    expect(emailId('alice+work@example.com')).not.toBe(emailId('alice@example.com'));
  });

  it('matches the known SHA-256 of the normalized input', () => {
    expect(emailId('Alice@Example.com')).toBe(
      'ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976',
    );
  });
});
