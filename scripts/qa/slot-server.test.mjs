import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';

const state = vi.hoisted(() => ({ dir: '', binary: '', child: null }));
vi.mock('./pool.mjs', () => ({
  get SRV_DIR() {
    return state.dir;
  },
  worktreeRoot: () => '/owned/server-diagnostic-fixture',
  die: (message) => {
    throw new Error(message);
  },
  info: () => {},
  sleep: async () => {
    if (state.child && state.child.exitCode === null) await once(state.child, 'exit');
  },
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original();
  return { ...actual, spawn: (...args) => (state.child = actual.spawn(...args)) };
});
vi.mock('../lib/sync-server.mjs', async (original) => ({
  ...(await original()),
  syncServerBinary: async () => ({ path: state.binary, source: 'owned-fixture' }),
}));
import * as server from './slot-server.mjs';

afterEach(async () => {
  vi.unstubAllGlobals();
  if (state.child?.exitCode === null) {
    state.child.kill(); // The exact child started by this test.
    await once(state.child, 'exit');
  }
  state.child = null;
  if (state.dir) fs.rmSync(state.dir, { recursive: true, force: true });
  state.dir = '';
});

it.skipIf(process.platform === 'win32')(
  'prints the actual failed server startup cause instead of hiding it in a log',
  async () => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-server-diagnostic-'));
    state.binary = path.join(state.dir, 'server-fixture');
    fs.writeFileSync(
      state.binary,
      `#!${process.execPath}\nconsole.error('refusing to initialize SQLite beside non-empty BLOB_DIR');process.exit(1);\n`,
      { mode: 0o755 },
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(server.cmdServerStart([])).rejects.toThrow(
      'refusing to initialize SQLite beside non-empty BLOB_DIR',
    );
    expect(state.child.exitCode).toBe(1);
  },
);

it('includes only bounded output from this startup and retains the log path', () => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-server-diagnostic-'));
  const log = path.join(state.dir, 'server.log');
  fs.writeFileSync(log, 'old-run-stale-error\n');
  const offset = fs.statSync(log).size;
  fs.appendFileSync(log, 'x'.repeat(20000) + '\ncurrent startup failed\n');
  const message = server.serverStartupFailureMessage(log, offset);
  expect(message).toContain('current startup failed');
  expect(message).toContain(log);
  expect(message).not.toContain('old-run-stale-error');
  expect(Buffer.byteLength(message)).toBeLessThan(17000);
});

it('names the log even when the current startup wrote nothing or the log cannot be read', () => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-server-diagnostic-'));
  const log = path.join(state.dir, 'missing.log');
  expect(server.serverStartupFailureMessage(log, 0)).toContain(log);
  fs.writeFileSync(log, 'old run\n');
  expect(server.serverStartupFailureMessage(log, fs.statSync(log).size)).not.toContain('old run');
});
