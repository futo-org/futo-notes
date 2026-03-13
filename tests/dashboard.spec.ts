import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { __setTestLlmResponder } from '../apps/server/src/plugins/llm.ts';
import { contentHash } from '../apps/server/src/sync/hash.ts';
import { createTestEnv, type TestEnv } from '../apps/server/tests/helpers/setup.ts';

const DASHBOARD_PASSWORD = 'dashboard-pass';
const TEN_MINUTES_MS = 10 * 60 * 1000;

interface DashboardHarness {
  env: TestEnv;
  server: Server;
  baseUrl: string;
  token: string;
}

interface SeedNoteInput {
  uuid: string;
  filename: string;
  content: string;
  modifiedAt?: number;
}

function buildLocalPluginSource(pluginId: string, name: string, description: string, targetTitle: string): string {
  return `export default {
  id: '${pluginId}',
  name: '${name}',
  description: '${description}',
  defaultEnabled: false,
  defaultSchedule: { kind: 'manual', time: null, day: null },
  defaultAutoApply: false,
  configSchema: [],
  async run(context) {
    const notes = await context.sdk.findNotes({ filenameGlob: 'Untitled*.md', limit: 1, sort: 'modified_desc' });
    if (notes.length === 0) {
      return { notesScanned: 0, proposalsCreated: 0, notesSkipped: 0 };
    }

    const note = notes[0];
    await context.sdk.proposeChange({
      entityType: 'note',
      entityId: note.uuid,
      changeType: 'rename_note',
      before: { title: note.title, filename: note.filename },
      after: { newTitle: '${targetTitle}', rewriteExactWikiLinks: true },
      preview: { oldTitle: note.title, proposedTitle: '${targetTitle}', noteUuid: note.uuid },
      reason: 'Local dashboard automation test',
    });
    return { notesScanned: 1, proposalsCreated: 1, notesSkipped: 0 };
  },
};
`;
}

async function startDashboardHarness(): Promise<DashboardHarness> {
  const env = createTestEnv();
  const server = createAdaptorServer({ fetch: env.app.fetch });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    server.close();
    env.cleanup();
    throw new Error('Failed to determine dashboard test server address');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const setupRes = await fetch(`${baseUrl}/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DASHBOARD_PASSWORD }),
  });
  if (!(setupRes.status === 201 || setupRes.status === 409)) {
    throw new Error(`Setup failed with HTTP ${setupRes.status}`);
  }

  const loginRes = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DASHBOARD_PASSWORD }),
  });
  if (!loginRes.ok) {
    throw new Error(`Login failed with HTTP ${loginRes.status}`);
  }

  const loginData = await loginRes.json() as { token: string };
  return { env, server, baseUrl, token: loginData.token };
}

async function stopDashboardHarness(harness: DashboardHarness | null): Promise<void> {
  if (!harness) return;
  __setTestLlmResponder(null);
  await new Promise<void>((resolve, reject) => {
    harness.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  harness.env.cleanup();
}

async function authPostJson(baseUrl: string, token: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function seedNotes(baseUrl: string, token: string, notes: SeedNoteInput[]): Promise<void> {
  const payload = {
    notes: notes.map((note) => ({
      uuid: note.uuid,
      filename: note.filename,
      modified_at: note.modifiedAt ?? (Date.now() - TEN_MINUTES_MS),
      content_hash: contentHash(note.content),
      hash_at_last_sync: '',
      content: note.content,
    })),
    inventory: notes.map((note) => ({
      uuid: note.uuid,
      filename: note.filename,
      modified_at: note.modifiedAt ?? (Date.now() - TEN_MINUTES_MS),
      content_hash: contentHash(note.content),
    })),
    deleted_uuids: [],
  };

  const syncRes = await authPostJson(baseUrl, token, '/sync', payload);
  if (!syncRes.ok) {
    throw new Error(`Sync seed failed with HTTP ${syncRes.status}`);
  }
}

async function loginDashboard(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl);
  await expect(page.locator('#plugin-grid')).toBeVisible({ timeout: 10_000 });

  page.once('dialog', (dialog) => dialog.accept(DASHBOARD_PASSWORD));
  await page.getByRole('button', { name: 'Log in' }).click();

  await expect(page.locator('.plugin-auth-note')).toContainText('Signed in for automation controls');
  await expect(page.locator('[data-plugin-switch]').first()).toBeEnabled();
}

async function openLatestRun(page: Page, pluginCard: Locator): Promise<void> {
  await expect(pluginCard.getByRole('button', { name: 'Open latest run' })).toBeVisible({ timeout: 10_000 });
  await pluginCard.getByRole('button', { name: 'Open latest run' }).click();
  await expect(page.getByRole('heading', { name: 'Latest Run' })).toBeVisible({ timeout: 10_000 });
}

test.describe('Server Dashboard', () => {
  let harness: DashboardHarness | null = null;

  test.beforeEach(async () => {
    harness = await startDashboardHarness();
  });

  test.afterEach(async () => {
    await stopDashboardHarness(harness);
    harness = null;
  });

  test('dashboard loads without JS errors and plugin controls unlock after login', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(harness!.baseUrl);

    await expect(page.locator('#status')).not.toHaveText('...', { timeout: 10_000 });
    await expect(page.locator('#status')).toContainText('Online');
    await expect(page.locator('#plugin-grid')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-plugin-card]')).toHaveCount(2);
    await expect(page.locator('[data-plugin-switch]').first()).toBeDisabled();

    const statusRes = await page.request.get(`${harness!.baseUrl}/dashboard/status`);
    expect(statusRes.ok()).toBeTruthy();
    const statusData = await statusRes.json();
    expect(statusData).toHaveProperty('plugins');
    expect(statusData.plugins.plugins.map((plugin: { id: string }) => plugin.id)).toEqual([
      'quick-capture-to-list',
      'weekly-related-notes',
    ]);

    page.once('dialog', (dialog) => dialog.accept(DASHBOARD_PASSWORD));
    await page.getByRole('button', { name: 'Log in' }).click();

    await expect(page.locator('.plugin-auth-note')).toContainText('Signed in for automation controls');
    await expect(page.locator('[data-plugin-switch]').first()).toBeEnabled();
    const pluginCard = page.locator('[data-plugin-card="quick-capture-to-list"]');
    const scheduleSelect = pluginCard.locator('[data-schedule-kind]');
    const weeklyDayField = pluginCard.locator('[data-schedule-day-field]');
    await expect(weeklyDayField).toBeHidden();
    await scheduleSelect.selectOption('weekly');
    await expect(weeklyDayField).toBeVisible();
    await scheduleSelect.selectOption('daily');
    await expect(weeklyDayField).toBeHidden();
    await expect(pluginCard).not.toContainText('Minimum note age');
    await expect(pluginCard).not.toContainText('Minimum content length');
    await expect(pluginCard).not.toContainText('Max content to analyze');
    await expect(pluginCard).not.toContainText('Recent title examples');
    await expect(pluginCard).not.toContainText('Model temperature');
    await expect(pluginCard).not.toContainText('Max output tokens');
    expect(pageErrors).toEqual([]);
  });

  test('untitled note preview flow shows proposed changes and applies approved list merge', async ({ page }) => {
    __setTestLlmResponder(() => 'Packing');

    await seedNotes(harness!.baseUrl, harness!.token, [
      {
        uuid: 'note-1',
        filename: 'Untitled.md',
        content: 'olive oil\nlemons',
      },
      {
        uuid: 'note-2',
        filename: 'Packing.md',
        content: 'Trip prep\n- socks\n- charger\n- passport\n\nLater\n- souvenirs',
      },
    ]);

    await expect.poll(async () => {
      const res = await fetch(`${harness!.baseUrl}/dashboard/status`);
      const data = await res.json() as { notes_count: number };
      return data.notes_count;
    }).toBe(2);

    await loginDashboard(page, harness!.baseUrl);

    const pluginCard = page.locator('[data-plugin-card="quick-capture-to-list"]');
    await expect(pluginCard).toContainText('Preview first');

    await pluginCard.getByRole('button', { name: 'Run now' }).click();
    await expect(pluginCard).toContainText('awaiting_approval', { timeout: 10_000 });
    await expect(pluginCard).toContainText('1 pending approvals', { timeout: 10_000 });

    await openLatestRun(page, pluginCard);

    const detail = page.locator('.plugin-detail');
    const runItem = detail.locator('.plugin-run-item').first();
    await expect(detail).toContainText('Changes');
    await expect(detail).toContainText('Activity');
    await expect(detail).toContainText('Source title');
    await expect(detail).toContainText('Untitled');
    await expect(detail).toContainText('Destination title');
    await expect(detail).toContainText('Packing');
    await expect(detail).toContainText('Move quick capture into the best matching list note');

    await runItem.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(runItem.locator('.badge').first()).toContainText('approved', { timeout: 10_000 });

    await page.getByRole('button', { name: 'Apply approved' }).click();
    await expect(runItem.locator('.badge').first()).toContainText('applied', { timeout: 10_000 });
    await expect(detail.locator('.plugin-detail-section').first().locator('.badge').first()).toContainText('succeeded', { timeout: 10_000 });

    expect(fs.existsSync(path.join(harness!.env.notesDir, 'Packing.md'))).toBe(true);
    expect(fs.existsSync(path.join(harness!.env.notesDir, 'Untitled.md'))).toBe(false);
    const packingContent = fs.readFileSync(path.join(harness!.env.notesDir, 'Packing.md'), 'utf8');
    expect(packingContent).toContain('- olive oil');
    expect(packingContent).toContain('  - lemons');
  });

  test('auto-apply setting accepts and applies untitled list merge without manual approval', async ({ page }) => {
    __setTestLlmResponder(() => 'Quick capture inbox');

    await seedNotes(harness!.baseUrl, harness!.token, [
      {
        uuid: 'note-3',
        filename: 'Untitled (2).md',
        content: 'call plumber',
      },
    ]);

    await loginDashboard(page, harness!.baseUrl);

    const pluginCard = page.locator('[data-plugin-card="quick-capture-to-list"]');
    const autoApplyToggle = pluginCard.locator('[data-auto-apply]');
    await autoApplyToggle.check();
    await pluginCard.getByRole('button', { name: 'Save settings' }).click();

    await expect(pluginCard).toContainText('Auto-apply on', { timeout: 10_000 });
    await expect(pluginCard.locator('[data-auto-apply]')).toBeChecked();

    await pluginCard.getByRole('button', { name: 'Run now' }).click();
    await expect(pluginCard).toContainText('succeeded', { timeout: 10_000 });
    await expect(pluginCard).toContainText('0 pending approvals', { timeout: 10_000 });

    await openLatestRun(page, pluginCard);

    const detail = page.locator('.plugin-detail');
    const runItem = detail.locator('.plugin-run-item').first();
    await expect(detail).toContainText('Quick capture inbox');
    await expect(runItem.locator('.badge').first()).toContainText('applied', { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Apply approved' })).toHaveCount(0);

    expect(fs.existsSync(path.join(harness!.env.notesDir, 'Quick capture inbox.md'))).toBe(true);
    expect(fs.existsSync(path.join(harness!.env.notesDir, 'Untitled (2).md'))).toBe(false);
  });

  test('local automation can be edited and deleted from the dashboard', async ({ page }) => {
    await seedNotes(harness!.baseUrl, harness!.token, [
      {
        uuid: 'note-local-1',
        filename: 'Untitled.md',
        content: 'A local automation should rename this note.',
      },
    ]);
    const createPluginRes = await authPostJson(harness!.baseUrl, harness!.token, '/plugins/local', {
      plugin_id: 'local-dashboard-e2e',
      source: buildLocalPluginSource(
        'local-dashboard-e2e',
        'Local Dashboard E2E',
        'Created for the dashboard test.',
        'local dashboard title',
      ),
    });
    expect(createPluginRes.status).toBe(201);

    await loginDashboard(page, harness!.baseUrl);
    await expect(page.getByRole('button', { name: 'New local automation' })).toHaveCount(0);

    const pluginCard = page.locator('[data-plugin-card="local-dashboard-e2e"]');
    await expect(pluginCard).toBeVisible({ timeout: 10_000 });
    await expect(pluginCard).toContainText('Local Dashboard E2E');
    await expect(pluginCard).toContainText('Local');

    await pluginCard.getByRole('button', { name: 'Run now' }).click();
    await expect(pluginCard).toContainText('awaiting_approval', { timeout: 10_000 });

    await openLatestRun(page, pluginCard);
    const detail = page.locator('.plugin-detail');
    const runItem = detail.locator('.plugin-run-item').first();
    await expect(detail).toContainText('local dashboard title');
    await runItem.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Apply approved' }).click();
    await expect(runItem.locator('.badge').first()).toContainText('applied', { timeout: 10_000 });
    expect(fs.existsSync(path.join(harness!.env.notesDir, 'local dashboard title.md'))).toBe(true);

    await pluginCard.getByRole('button', { name: 'Edit code' }).click();
    await expect(page.locator('#plugin-editor-modal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#plugin-editor-id')).toHaveValue('local-dashboard-e2e');
    await expect(page.locator('#plugin-editor-id')).toBeDisabled();
    await page.locator('#plugin-editor-source').fill(
      buildLocalPluginSource(
        'local-dashboard-e2e',
        'Local Dashboard E2E Updated',
        'Updated from the dashboard.',
        'local dashboard title',
      ),
    );
    await page.getByRole('button', { name: 'Save changes' }).click();
    await pluginCard.getByRole('button', { name: 'Edit code' }).click();
    await expect(page.locator('#plugin-editor-modal')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#plugin-editor-source')).toHaveValue(/Local Dashboard E2E Updated/);
    await expect(page.locator('#plugin-editor-source')).toHaveValue(/Updated from the dashboard\./);
    await page.getByRole('button', { name: 'Close' }).click();

    page.once('dialog', (dialog) => dialog.accept());
    await pluginCard.getByRole('button', { name: 'Delete' }).click();
    await expect(pluginCard).toHaveCount(0, { timeout: 10_000 });
  });
});
