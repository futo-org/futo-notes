#!/usr/bin/env node
/**
 * Local `just test-desktop-smoke`: launch an isolated debug app (own data dir and vault under
 * .tauri-data/, never the real one), run desktop-smoke.mjs against it, quit it. Needs the binary
 * from `just build-desktop-test`; CI starts its own app and calls desktop-smoke.mjs directly.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktopTauriInstance } from './lib/tauri-instance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = await startDesktopTauriInstance('smoke', root);
try {
  const { status } = spawnSync(
    process.execPath,
    [
      join(root, 'tests', 'desktop-smoke.mjs'),
      '--port',
      String(client.port),
      '--notes-dir',
      client.notesDir,
    ],
    { stdio: 'inherit' },
  );
  process.exitCode = status ?? 1;
} finally {
  client.stop();
}
