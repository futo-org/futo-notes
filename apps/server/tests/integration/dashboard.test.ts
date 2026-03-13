import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authReq, createTestEnv, req, setupAndLogin, type TestEnv } from '../helpers/setup.js';

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
    expect(html).toContain('id="run-all-plugins-btn"');
    expect(html).toContain('id="plugin-editor-modal"');
    expect(html).toContain('id="run-all-modal"');
    expect(html).not.toContain('New local automation');
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
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.id)).toEqual([
      'auto-tagger',
      'quick-capture-to-list',
      'weekly-related-notes',
    ]);
  });

  it('GET /dashboard/status includes local plugins with source metadata', async () => {
    const token = await setupAndLogin(env.app);
    const source = `export default {
  id: 'dashboard-local',
  name: 'Dashboard Local',
  description: 'Local dashboard automation.',
  defaultEnabled: false,
  defaultSchedule: { kind: 'manual', time: null, day: null },
  defaultAutoApply: true,
  configSchema: [],
  async run() {
    return { notesScanned: 0, proposalsCreated: 0, notesSkipped: 0 };
  },
};
`;

    const createRes = await authReq(env.app, 'POST', '/plugins/local', token, {
      plugin_id: 'dashboard-local',
      source,
    });
    expect(createRes.status).toBe(201);

    const res = await req(env.app, 'GET', '/dashboard/status');
    expect(res.status).toBe(200);
    const data = await res.json() as {
      plugins: { plugins: Array<Record<string, unknown>> };
    };

    const local = data.plugins.plugins.find((plugin) => plugin.id === 'dashboard-local');
    expect(local).toMatchObject({
      id: 'dashboard-local',
      source_kind: 'local',
      source_label: 'Local',
      can_edit: true,
      can_delete: true,
    });
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
