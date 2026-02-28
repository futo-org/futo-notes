import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../src/db/index.js';
import { createSearchTables } from '../../src/db/searchSchema.js';
import { clearRateLimitStore } from '../../src/middleware/rateLimit.js';
import { createApp } from '../../src/app.js';
import type { Hono } from 'hono';

interface TestEnv {
  app: Hono;
  tmpDir: string;
  cleanup: () => void;
}

function createSearchTestEnv(): TestEnv {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'futo-search-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const notesDir = path.join(tmpDir, 'notes');

  process.env.DATABASE_PATH = dbPath;
  process.env.NOTES_PATH = notesDir;
  process.env.SEARCH_ENABLED = 'true';

  initDb(dbPath);
  createSearchTables(getDb());
  clearRateLimitStore();

  const app = createApp();

  return {
    app,
    tmpDir,
    cleanup: () => {
      closeDb();
      rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.DATABASE_PATH;
      delete process.env.NOTES_PATH;
      delete process.env.SEARCH_ENABLED;
    },
  };
}

async function req(
  app: Hono,
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return app.request(urlPath, init);
}

async function setupAndLogin(app: Hono, password = 'testpassword123'): Promise<string> {
  await req(app, 'POST', '/setup', { password });
  const res = await req(app, 'POST', '/login', { password });
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function authReq(
  app: Hono,
  method: string,
  urlPath: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return req(app, method, urlPath, body, { Authorization: `Bearer ${token}` });
}

describe('Search API', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createSearchTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  describe('GET /search/capabilities', () => {
    it('requires authentication', async () => {
      const res = await req(env.app, 'GET', '/search/capabilities');
      expect(res.status).toBe(401);
    });

    it('returns capabilities', async () => {
      const res = await authReq(env.app, 'GET', '/search/capabilities', token);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveProperty('levels');
      expect(data).toHaveProperty('chunk_count');
      expect(data).toHaveProperty('last_indexed_at');
      expect(data).toHaveProperty('methods');
      expect(data.methods).toHaveProperty('keyword');
      expect(data.methods).toHaveProperty('vector');
      expect(data.methods).toHaveProperty('hybrid');
      expect(data.methods.keyword.supported).toBe(true);
      expect(data.methods.vector.supported).toBe(false);
      expect(data.methods.hybrid.supported).toBe(false);
      expect(data.chunk_count).toBe(0);
    });
  });

  describe('GET /search/status', () => {
    it('requires authentication', async () => {
      const res = await req(env.app, 'GET', '/search/status');
      expect(res.status).toBe(401);
    });

    it('returns status with no jobs', async () => {
      const res = await authReq(env.app, 'GET', '/search/status', token);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.current_job).toBeNull();
      expect(data.last_run).toBeNull();
    });
  });

  describe('POST /search/reindex', () => {
    it('requires authentication', async () => {
      const res = await req(env.app, 'POST', '/search/reindex');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /search/change-model', () => {
    it('requires authentication', async () => {
      const res = await req(env.app, 'POST', '/search/change-model', { model_id: 'qwen3-embedding-0.6b-q8_0' });
      expect(res.status).toBe(401);
    });

    it('returns 400 for unknown model id', async () => {
      const res = await authReq(env.app, 'POST', '/search/change-model', token, { model_id: 'not-a-real-model' });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toContain('Unknown model');
    });
  });

  describe('POST /search/set-enhanced-search', () => {
    it('requires authentication', async () => {
      const res = await req(env.app, 'POST', '/search/set-enhanced-search', { enabled: false });
      expect(res.status).toBe(401);
    });

    it('returns 400 for invalid enabled flag', async () => {
      const res = await authReq(env.app, 'POST', '/search/set-enhanced-search', token, { enabled: 'nope' });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toContain('enabled');
    });
  });

  describe('GET /search/index', () => {
    it('requires authentication', async () => {
      const res = await req(env.app, 'GET', '/search/index');
      expect(res.status).toBe(401);
    });

    it('returns 404 when no artifact exists', async () => {
      const res = await authReq(env.app, 'GET', '/search/index', token);
      expect(res.status).toBe(404);
    });

    it('returns 404 for manifest when no artifact exists', async () => {
      const res = await authReq(env.app, 'GET', '/search/index?format=manifest', token);
      expect(res.status).toBe(404);
    });

    it('returns 404 for bin when no artifact exists', async () => {
      const res = await authReq(env.app, 'GET', '/search/index?format=bin', token);
      expect(res.status).toBe(404);
    });
  });
});

describe('Search routes disabled', () => {
  let tmpDir: string;
  let app: Hono;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'futo-nosearch-test-'));
    process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
    process.env.NOTES_PATH = path.join(tmpDir, 'notes');
    process.env.SEARCH_ENABLED = 'false';

    initDb(process.env.DATABASE_PATH);
    clearRateLimitStore();
    app = createApp();
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.NOTES_PATH;
  });

  it('returns 404 for search endpoints when disabled', async () => {
    const token = await setupAndLogin(app);
    const res = await authReq(app, 'GET', '/search/capabilities', token);
    expect(res.status).toBe(404);
  });
});
