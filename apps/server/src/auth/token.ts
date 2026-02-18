import crypto from 'node:crypto';

/** Generate a 32-byte cryptographically random token, returned as hex. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** SHA-256 hash of a token, used for storage (never store raw tokens). */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
