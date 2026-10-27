import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseIosRemoteArgs } from './ios-remote.mjs';
import { bootstrapScript, runScript, shellPath } from './ios-remote/scripts.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it('exposes remote iOS help without network or device setup', () => {
  const result = spawnSync('just', ['ios-remote', '--help'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('test-ios-native-ui');
});

it('keeps suite names literal and rejects unsupported recipes before networking', () => {
  const parsed = parseIosRemoteArgs(
    ['--host', 'example.test', 'test-ios-native-ui', 'Class/test with spaces', '$(not-code)'],
    {},
  );
  expect(parsed.recipeArgs).toEqual(['Class/test with spaces', '$(not-code)']);
  expect(() => parseIosRemoteArgs(['deploy-ios'], {})).toThrow('Choose a native');
  expect(() => parseIosRemoteArgs(['--host'], {})).toThrow('Invalid option');
});
it('does not execute configured path punctuation in a shell', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ios-remote-quote-'));
  dirs.push(dir);
  const value = `${dir}/two words $(touch escaped) ' literal`;
  const result = spawnSync(
    'bash',
    ['-c', `configured=${shellPath(value)}\nprintf '%s' "$configured"`],
    { cwd: dir, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(value);
});
it('generates parseable bootstrap code with all request values quoted', () => {
  const script = bootstrapScript({
    pin: '22.23.1',
    repo: "$HOME/a ' repository",
    id: 'abc123',
    sha: 'a'.repeat(40),
    digest: 'b'.repeat(64),
    runDir: "/tmp/a ' run",
    remoteDir: '/tmp/remote space',
    bundle: true,
    minFreeGiB: '2',
  });
  expect(script).toContain('--no-install --no-target');
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});

it('forwards native options as distinct literal environment values', () => {
  const script = bootstrapScript({
    pin: '22.23.1',
    repo: '/tmp/repo',
    id: 'abc',
    sha: 'a'.repeat(40),
    digest: 'b'.repeat(64),
    runDir: '/tmp/run',
    remoteDir: '/tmp/remote',
    bundle: false,
    minFreeGiB: '2',
    forwarded: { IOS_TEXT_INPUT: 'softwareKeyboard', IOS_STORY_FILTER: 'self link $literal' },
  });
  const prefix = script.slice(0, script.indexOf('\ncleanup()'));
  const result = spawnSync(
    'bash',
    ['-c', prefix + `\nprintf '%s|%s' "$IOS_TEXT_INPUT" "$IOS_STORY_FILTER"`],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('softwareKeyboard|self link $literal');
});

it.each([0, 65])(
  'keeps test exit %s meaningful when bootstrap cleanup finds unknown data',
  (testExit) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ios-remote-cleanup-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'unrelated.data'), 'preserve');
    writeFileSync(path.join(dir, 'source.tar.gz'), 'owned artifact');
    const script = bootstrapScript({
      pin: '22.23.1',
      repo: '/tmp/repo',
      id: 'abc',
      sha: 'a'.repeat(40),
      digest: 'b'.repeat(64),
      runDir: dir,
      remoteDir: '/tmp/remote',
      bundle: false,
      minFreeGiB: '2',
    });
    const prefix = script.slice(0, script.indexOf('[ "$(shasum'));
    const result = spawnSync('bash', ['-c', prefix + `\nexit ${testExit}`], { encoding: 'utf8' });
    expect(result.status).toBe(testExit || 1);
    expect(existsSync(path.join(dir, 'unrelated.data'))).toBe(true);
    expect(existsSync(path.join(dir, 'source.tar.gz'))).toBe(false);
  },
);

it('releases a partially acquired simulator claim when boot/setup fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ios-remote-claim-'));
  dirs.push(dir);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const trace = path.join(dir, 'claim.trace');
  writeFileSync(
    path.join(bin, 'just'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CLAIM_TRACE"\ncase "$1" in qa-claim) exit 42 ;; qa-release) exit 0 ;; *) exit 99 ;; esac\n',
    { mode: 0o755 },
  );
  const generated = runScript({ sha: 'a'.repeat(40), id: 'abc', digest: 'b'.repeat(64) });
  const tail = generated.slice(generated.indexOf('CLAIMED=0'));
  const result = spawnSync('bash', ['-c', 'set -euo pipefail\nRECIPE=test-ios-native\n' + tail], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAIM_TRACE: trace },
  });
  expect(result.status, result.stderr).toBe(42);
  expect(readFileSync(trace, 'utf8')).toContain('qa-release ios');
});

it.each(['same', 'changed', 'missing', 'failed'])(
  'refreshes dependencies after source application (%s installed lock)',
  (state) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ios-remote-deps-'));
    dirs.push(dir);
    mkdirSync(path.join(dir, 'node_modules/.pnpm'), { recursive: true });
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'current');
    if (state !== 'missing')
      writeFileSync(
        path.join(dir, 'node_modules/.pnpm/lock.yaml'),
        state === 'same' ? 'current' : 'old',
      );
    const generated = runScript({ sha: 'a'.repeat(40), id: 'abc', digest: 'b'.repeat(64) });
    const refresh = generated.slice(generated.indexOf('echo '), generated.indexOf('CLAIMED=0'));
    const result = spawnSync(
      'bash',
      [
        '-euc',
        `
      pnpm() { echo "pnpm $*"; return ${state === 'failed' ? 42 : 0}; }
      node() { echo "node $*"; }
      just() { echo "just $*"; }
      ${refresh}
    `,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(state === 'failed' ? 42 : 0);
    expect(result.stdout.includes('pnpm install --frozen-lockfile')).toBe(state !== 'same');
    expect(result.stdout.includes('node scripts/check-node-modules.mjs')).toBe(state !== 'failed');
    expect(result.stdout.includes('just editor-deps')).toBe(state !== 'failed');
  },
);
