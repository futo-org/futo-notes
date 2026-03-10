import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, req, type TestEnv } from '../helpers/setup.js';

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
    expect(html).toContain('Automations');
    expect(html).not.toContain('plugin-install-url');

    // Verify the script tag is present and parseable
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).toBeTruthy();

    // Check that escaped quotes in onclick handlers are correct
    expect(html).not.toContain("triggerPlugin('' +");
    expect(html).not.toContain("togglePlugin('' +");
    expect(html).not.toContain('installPlugin()');
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

  it('GET /dashboard/status includes built-in plugin status when enabled', async () => {
    const res = await req(env.app, 'GET', '/dashboard/status');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;

    expect(data).toHaveProperty('plugins');
    const plugins = data.plugins as Record<string, unknown>;
    expect(plugins).toHaveProperty('plugins');
    expect(plugins).toHaveProperty('model');
    expect(plugins).toHaveProperty('scheduler');
    const items = plugins.plugins as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('untitled-no-more');
  });

  it('GET /dashboard/status returns plugins: null when disabled', async () => {
    process.env.PLUGINS_ENABLED = 'false';
    env.cleanup();
    env = createTestEnv();

    const res = await req(env.app, 'GET', '/dashboard/status');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;

    expect(data.plugins).toBeNull();
    delete process.env.PLUGINS_ENABLED;
  });
});
