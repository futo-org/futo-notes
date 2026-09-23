import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDesktopTauriInstance } from './tauri-instance.mjs';

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

it('refuses a restart storage override outside the run before writing anything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-storage-'));
  roots.push(root);
  vi.stubEnv('FUTO_VERIFICATION_DIR', path.join(root, 'verification-runs', 'run'));
  const outside = path.join(root, 'unrelated-vault');
  await expect(
    startDesktopTauriInstance('unsafe', root, {
      storage: { instanceDir: outside, dataDir: outside, notesDir: outside },
    }),
  ).rejects.toThrow(/storage.*run/i);
  expect(fs.existsSync(outside)).toBe(false);
});

it('refuses a symlinked restart vault before writing its override or starting an app', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-storage-'));
  roots.push(root);
  const parent = path.join(root, 'verification-runs', 'run');
  vi.stubEnv('FUTO_VERIFICATION_DIR', parent);
  const instanceDir = path.join(parent, 'desktop-owned');
  fs.mkdirSync(instanceDir, { recursive: true });
  const outside = path.join(root, 'unrelated-vault');
  fs.mkdirSync(outside);
  const notesDir = path.join(instanceDir, 'notes');
  fs.symlinkSync(outside, notesDir);
  const dataDir = path.join(instanceDir, 'data');
  await expect(
    startDesktopTauriInstance('unsafe', root, { storage: { instanceDir, dataDir, notesDir } }),
  ).rejects.toThrow(/storage.*run/i);
  expect(fs.existsSync(path.join(dataDir, 'notes-dir-override.json'))).toBe(false);
  expect(fs.readdirSync(outside)).toEqual([]);
});
