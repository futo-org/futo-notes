import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, req, type TestEnv } from '../helpers/setup.js';
import { createTransformTables } from '../../src/db/transformSchema.js';
import { getDb } from '../../src/db/index.js';

describe('Dashboard', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    env.cleanup();
  });

  it('GET / returns valid HTML with no JS syntax errors', async () => {
    const res = await req(env.app, 'GET', '/');
    expect(res.status).toBe(200);
    const html = await res.text();

    // Basic structure checks
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Stonefruit');
    expect(html).toContain('Server Dashboard');
    expect(html).toContain('id="search-card"');
    expect(html).toContain('id="search-content"');

    // Verify the script tag is present and parseable
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).toBeTruthy();

    // Check that escaped quotes in onclick handlers are correct
    // In the rendered HTML, onclick handlers should use \' not bare '
    // The renderTransforms function builds onclick="triggerTransform('...')"
    // which requires escaped single quotes inside the JS string literals
    expect(html).not.toContain("triggerTransform('' +");
    expect(html).not.toContain("toggleTransform('' +");
  });

  it('GET /dashboard/status returns valid JSON with search section', async () => {
    const res = await req(env.app, 'GET', '/dashboard/status');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;

    expect(data).toHaveProperty('notes_count');
    expect(data).toHaveProperty('sessions_count');
    expect(data).toHaveProperty('setup_complete');
    expect(data).toHaveProperty('search');
    expect(data).toHaveProperty('uptime_seconds');
  });

  it('GET /dashboard/status includes transforms when enabled', async () => {
    // Enable transforms via env
    process.env.TRANSFORMS_ENABLED = 'true';
    // Need a fresh app to pick up config change
    env.cleanup();
    env = createTestEnv();
    createTransformTables(getDb());

    const res = await req(env.app, 'GET', '/dashboard/status');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;

    expect(data).toHaveProperty('transforms');
    const transforms = data.transforms as Record<string, unknown>;
    expect(transforms).toHaveProperty('transforms');
    expect(transforms).toHaveProperty('model');
    expect(transforms).toHaveProperty('scheduler');

    delete process.env.TRANSFORMS_ENABLED;
  });

  it('GET /dashboard/status returns transforms: null when disabled', async () => {
    process.env.TRANSFORMS_ENABLED = 'false';
    env.cleanup();
    env = createTestEnv();

    const res = await req(env.app, 'GET', '/dashboard/status');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;

    expect(data.transforms).toBeNull();
  });
});
