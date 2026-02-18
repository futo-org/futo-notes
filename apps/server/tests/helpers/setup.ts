import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import type { Hono } from 'hono';

export interface TestEnv {
  app: Hono;
  dbPath: string;
  notesDir: string;
  tmpDir: string;
  cleanup: () => void;
}

/**
 * Create an isolated test environment with a temp directory, fresh DB, and app instance.
 * The config module is bypassed — the DB is initialized directly and tests pass notesDir
 * to the sync engine manually via the app's request interface.
 */
export function createTestEnv(): TestEnv {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'futo-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const notesDir = path.join(tmpDir, 'notes');

  initDb(dbPath);

  // Override config for test — set env vars before creating app
  process.env.DATABASE_PATH = dbPath;
  process.env.NOTES_PATH = notesDir;

  const app = createApp();

  return {
    app,
    dbPath,
    notesDir,
    tmpDir,
    cleanup: () => {
      closeDb();
      rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.DATABASE_PATH;
      delete process.env.NOTES_PATH;
    },
  };
}

/** Helper to make requests against the test app. */
export async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return app.request(path, init);
}

/** Setup password and login, returning the auth token. */
export async function setupAndLogin(
  app: Hono,
  password = 'testpassword123',
): Promise<string> {
  await req(app, 'POST', '/setup', { password });
  const res = await req(app, 'POST', '/login', { password });
  const data = (await res.json()) as { token: string };
  return data.token;
}

/** Make an authenticated request. */
export async function authReq(
  app: Hono,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return req(app, method, path, body, { Authorization: `Bearer ${token}` });
}
