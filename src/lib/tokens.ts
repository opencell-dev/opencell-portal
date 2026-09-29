import { createHash, randomBytes } from 'node:crypto';

/** A fresh 256-bit secret, base64url (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores in place of a token: its SHA-256, hex. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
