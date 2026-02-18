import crypto from 'node:crypto';

/** SHA-256 hex digest of content string. */
export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}
