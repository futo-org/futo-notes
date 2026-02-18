import { Hono } from 'hono';
import type { HealthResponse } from '@futo-notes/shared';
import { getDb } from '../db/index.js';
import { isSetupComplete } from '../db/auth.js';

const health = new Hono();

health.get('/health', (c) => {
  const db = getDb();
  const resp: HealthResponse = {
    status: 'ok',
    setup_complete: isSetupComplete(db),
  };
  return c.json(resp);
});

export default health;
