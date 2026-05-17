import { createHash } from 'node:crypto';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailId(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}
