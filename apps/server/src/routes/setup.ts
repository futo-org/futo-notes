import { Hono } from 'hono';
import type { SetupRequest } from '@futo-notes/shared';
import { getDb } from '../db/index.js';
import { isSetupComplete, setPasswordHash } from '../db/auth.js';
import { hashPassword } from '../auth/password.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { log } from '../logger.js';
import { parseJsonBody, validatePassword } from './helpers.js';

const setup = new Hono();

setup.post('/setup', rateLimit(5), async (c) => {
  const parsed = await parseJsonBody<SetupRequest>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  const pwErr = validatePassword(body.password);
  if (pwErr) return c.json({ error: pwErr.error }, pwErr.status);

  const db = getDb();
  if (isSetupComplete(db)) {
    log.warn('setup rejected — password already set');
    return c.json({ error: 'Password already set' }, 409);
  }

  const hash = await hashPassword(body.password);
  setPasswordHash(db, hash);
  log.info('setup complete — password configured');
  return c.json({ success: true }, 201);
});

export default setup;
