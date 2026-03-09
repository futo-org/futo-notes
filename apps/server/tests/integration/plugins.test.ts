import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPluginTables } from '../../src/db/pluginSchema.js';
import { getDb } from '../../src/db/index.js';
import { loadConfig } from '../../src/config.js';
import { syncBuiltinPlugins } from '../../src/plugins/loader.js';
import { authReq, createTestEnv, setupAndLogin, type TestEnv } from '../helpers/setup.js';

function runGit(dir: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: dir,
    stdio: 'pipe',
  });
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.name', 'Stonefruit Tests']);
  runGit(dir, ['config', 'user.email', 'tests@example.com']);
}

function commitRepo(dir: string, message: string): void {
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', message, '--no-gpg-sign']);
}

describe('Plugins', () => {
  let env: TestEnv;
  let reposRoot = '';
  let exampleRepoDir = '';
  let codeRepoDir = '';
  let exampleVersion = '1.0.0';
  let examplePermissions = ['read_note_metadata', 'read_note_content', 'rename_note'];

  function writeExamplePluginRepo(): void {
    fs.writeFileSync(path.join(exampleRepoDir, 'plugin.yaml'), [
      'id: example-plugin',
      'name: Example Plugin',
      `version: ${exampleVersion}`,
      'publisher: Example Labs',
      'description: Example plugin for tests.',
      'kind: note_automation',
      'execution: declarative',
      'entrypoint: prompt.md',
      'frequency: weekly',
      'permissions:',
      ...examplePermissions.map((permission) => `  - ${permission}`),
      'selector:',
      '  filename_glob: "*.md"',
    ].join('\n'));
    fs.writeFileSync(path.join(exampleRepoDir, 'prompt.md'), 'Return no actions for every note.');
  }

  function writeCodePluginRepo(): void {
    fs.mkdirSync(path.join(codeRepoDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(codeRepoDir, 'plugin.yaml'), [
      'id: code-plugin',
      'name: Code Plugin',
      'version: 1.0.0',
      'publisher: Example Labs',
      'description: Full-trust code plugin for tests.',
      'kind: note_automation',
      'entrypoint: main.cjs',
      'frequency: weekly',
    ].join('\n'));
    fs.writeFileSync(path.join(codeRepoDir, 'lib', 'pending.cjs'), [
      'module.exports = function getPendingNotes() {',
      '  return [];',
      '};',
    ].join('\n'));
    fs.writeFileSync(path.join(codeRepoDir, 'main.cjs'), [
      'const getPendingNotes = require(\'./lib/pending.cjs\');',
      '',
      'module.exports = {',
      '  getPendingNotes,',
      '  async execute() { return []; },',
      '};',
    ].join('\n'));
  }

  beforeEach(async () => {
    env = createTestEnv();
    createPluginTables(getDb());
    syncBuiltinPlugins(getDb(), loadConfig());

    reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stonefruit-plugin-repos-'));

    exampleRepoDir = path.join(reposRoot, 'example-plugin');
    initRepo(exampleRepoDir);
    writeExamplePluginRepo();
    commitRepo(exampleRepoDir, 'Initial example plugin');

    codeRepoDir = path.join(reposRoot, 'code-plugin');
    initRepo(codeRepoDir);
    writeCodePluginRepo();
    commitRepo(codeRepoDir, 'Initial code plugin');
  });

  afterEach(() => {
    if (reposRoot) {
      fs.rmSync(reposRoot, { recursive: true, force: true });
    }
    env.cleanup();
  });

  it('lists built-in plugins after bootstrap', async () => {
    const token = await setupAndLogin(env.app);
    const res = await authReq(env.app, 'GET', '/plugins/status', token);
    expect(res.status).toBe(200);
    const data = await res.json() as {
      security: { restricted_mode: boolean };
      plugins: Array<{ id: string; origin: string; execution: string }>;
    };
    expect(data.security.restricted_mode).toBe(true);
    expect(data.plugins.some((plugin) => plugin.id === 'untitled-no-more' && plugin.origin === 'builtin' && plugin.execution === 'full-trust')).toBe(true);
  });

  it('installs, updates, and uninstalls a plugin repo from source_url', async () => {
    const token = await setupAndLogin(env.app);
    const sourceUrl = pathToFileURL(exampleRepoDir).toString();

    const installRes = await authReq(env.app, 'POST', '/plugins/install', token, {
      source_url: sourceUrl,
      trust: true,
    });
    expect(installRes.status).toBe(201);

    const statusAfterInstall = await authReq(env.app, 'GET', '/plugins/status', token);
    const installedData = await statusAfterInstall.json() as {
      plugins: Array<{ id: string; version: string; origin: string; installed_from: string | null }>;
    };
    expect(installedData.plugins.some((plugin) => (
      plugin.id === 'example-plugin'
      && plugin.version === '1.0.0'
      && plugin.origin === 'installed'
      && plugin.installed_from === sourceUrl
    ))).toBe(true);

    const enableRes = await authReq(env.app, 'POST', '/plugins/example-plugin/enable', token);
    expect(enableRes.status).toBe(200);

    exampleVersion = '1.1.0';
    writeExamplePluginRepo();
    commitRepo(exampleRepoDir, 'Bump example plugin version');

    const updateRes = await authReq(env.app, 'POST', '/plugins/example-plugin/update', token, {});
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json() as { plugin: { version: string } };
    expect(updated.plugin.version).toBe('1.1.0');

    examplePermissions = ['read_note_metadata', 'read_note_content', 'rename_note', 'edit_note_content'];
    writeExamplePluginRepo();
    commitRepo(exampleRepoDir, 'Expand example plugin permissions');

    const blockedRes = await authReq(env.app, 'POST', '/plugins/example-plugin/update', token, {});
    expect(blockedRes.status).toBe(409);

    const approvedRes = await authReq(env.app, 'POST', '/plugins/example-plugin/update', token, {
      approve_permission_changes: true,
    });
    expect(approvedRes.status).toBe(200);

    const deleteRes = await authReq(env.app, 'DELETE', '/plugins/example-plugin', token);
    expect(deleteRes.status).toBe(200);

    const finalStatus = await authReq(env.app, 'GET', '/plugins/status', token);
    const finalData = await finalStatus.json() as { plugins: Array<{ id: string }> };
    expect(finalData.plugins.some((plugin) => plugin.id === 'example-plugin')).toBe(false);
  });

  it('blocks installed full-trust repo plugins until restricted mode is disabled', async () => {
    const token = await setupAndLogin(env.app);

    const installRes = await authReq(env.app, 'POST', '/plugins/install', token, {
      source_url: pathToFileURL(codeRepoDir).toString(),
      trust: true,
    });
    expect(installRes.status).toBe(201);

    const blockedStatus = await authReq(env.app, 'GET', '/plugins/status', token);
    const blockedData = await blockedStatus.json() as {
      plugins: Array<{ id: string; blocked_by_restricted_mode: boolean; execution: string }>;
      security: { restricted_mode: boolean };
    };
    expect(blockedData.security.restricted_mode).toBe(true);
    expect(blockedData.plugins.some((plugin) => plugin.id === 'code-plugin' && plugin.execution === 'full-trust' && plugin.blocked_by_restricted_mode)).toBe(true);

    const toggleRes = await authReq(env.app, 'POST', '/plugins/restricted-mode', token, { enabled: false });
    expect(toggleRes.status).toBe(200);

    const unblockedStatus = await authReq(env.app, 'GET', '/plugins/status', token);
    const unblockedData = await unblockedStatus.json() as {
      plugins: Array<{ id: string; blocked_by_restricted_mode: boolean }>;
      security: { restricted_mode: boolean };
    };
    expect(unblockedData.security.restricted_mode).toBe(false);
    expect(unblockedData.plugins.some((plugin) => plugin.id === 'code-plugin' && plugin.blocked_by_restricted_mode === false)).toBe(true);
  });
});
