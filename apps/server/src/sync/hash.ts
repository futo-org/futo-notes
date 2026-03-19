import crypto from 'node:crypto';

/** SHA-256 hex digest of content string. */
export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** SHA-256 hex digest of binary data. */
export function binaryContentHash(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
