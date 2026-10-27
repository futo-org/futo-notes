import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { buildNodePreflightScript, buildRunScript } from './remote-scripts.mjs';

const scratchpads = [];
afterEach(() => {
  for (const dir of scratchpads.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runPreflight({ configuredFnm = false } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'remote-node-'));
  scratchpads.push(home);
  const fnmDir = path.join(home, 'custom-fnm');
  if (configuredFnm) {
    mkdirSync(fnmDir);
    writeFileSync(path.join(fnmDir, 'fnm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return spawnSync('/bin/bash', ['-s'], {
    input: buildNodePreflightScript({ ndkVersion: 'fixture' }),
    env: { HOME: home, PATH: '/usr/bin:/bin', FNM_DIR: fnmDir },
    encoding: 'utf8',
  });
}

it('fails preflight with repair guidance when fnm is absent', () => {
  const result = runPreflight();
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('fnm is missing');
  expect(result.stderr).toContain('node scripts/remote-test.mjs --doctor');
  expect(result.stderr).toContain('install fnm on the remote host');
});

it('discovers fnm in the configured FNM_DIR without a shell profile', () => {
  const result = runPreflight({ configuredFnm: true });
  expect(result.status, result.stderr).toBe(0);
});

it('checks prerequisites before taking a lock or transferring sources', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'remote-preflight-cli-'));
  scratchpads.push(root);
  const log = path.join(root, 'ssh-input');
  writeFileSync(
    path.join(root, 'ssh'),
    '#!/bin/bash\nif [[ "${*: -1}" == true ]]; then exit 0; fi\ncat > "$PREFLIGHT_LOG"\nexit 2\n',
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    ['scripts/remote-test.mjs', '--host', 'fixture', '--rsync', 'test-unit'],
    {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PREFLIGHT_LOG: log },
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(2);
  const script = readFileSync(log, 'utf8');
  expect(script).toContain('fnm is missing');
  expect(script).not.toContain('LOCK_DIR=');
});

it('reports a failed pinned Node activation before invoking package installation', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'remote-node-activation-'));
  scratchpads.push(home);
  const bin = path.join(home, '.local/bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'fnm'), '#!/bin/sh\n[ "$1" = env ] && exit 0\nexit 1\n', {
    mode: 0o755,
  });
  writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho fixture-sha\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\necho PACKAGE-INSTALL-RAN >&2\n', {
    mode: 0o755,
  });
  const remoteDir = path.join(home, 'checkout');
  mkdirSync(remoteDir);
  mkdirSync(`${remoteDir}.lock`);
  writeFileSync(`${remoteDir}.lock/nonce`, 'fixture-nonce');
  const result = spawnSync('/bin/bash', ['-s'], {
    input: buildRunScript({
      remoteDir,
      sourceRepo: home,
      mode: 'rsync',
      sha: 'fixture-sha',
      recipe: 'test-unit',
      nonce: 'fixture-nonce',
      ndkVersion: 'fixture',
    }),
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('could not activate the Node version in .nvmrc');
  expect(result.stderr).not.toContain('PACKAGE-INSTALL-RAN');
});
