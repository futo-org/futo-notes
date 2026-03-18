import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

let currentToken: string | null = null;

/** Generate a new 32-byte random admin token and store it in memory. */
export function generateAdminToken(): string {
  currentToken = crypto.randomBytes(32).toString('hex');
  return currentToken;
}

/** Return the current in-memory admin token. */
export function getAdminToken(): string | null {
  return currentToken;
}

/** Write the admin token to `<dataDir>/.admin-token` with mode 0o600. */
export function writeAdminToken(dataDir: string, token: string): void {
  const tokenPath = path.join(dataDir, '.admin-token');
  fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  log.info(`admin-token: written to ${tokenPath}`);
}
