import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
afterEach(() => vi.unstubAllEnvs());
import { runRustTests, syncNextestArgs, ensureNextest } from './rust-tests.mjs';

function harness(statuses = []) {
  const calls = [];
  const planned = [...statuses];
  return {
    calls,
    root: '/repo',
    nextest: '/tools/cargo-nextest',
    exec: (command, args) => {
      calls.push({ command, args });
      return { status: planned.shift() ?? 0 };
    },
  };
}

describe('bounded Rust sync entrypoint', () => {
  it('runs all ordinary sync tests with named timeouts, then explicit doc tests', () => {
    const h = harness();
    expect(runRustTests({ ...h, scope: 'sync' })).toBe(0);
    expect(h.calls[0].command).toBe('/tools/cargo-nextest');
    expect(h.calls[0].args).toEqual(syncNextestArgs());
    expect(h.calls[0].args).toContain('--no-tests=fail');
    expect(h.calls[0].args).toContain('--profile=sync');
    expect(h.calls[0].args).not.toContain('--run-ignored=all');
    expect(h.calls[1]).toEqual({
      command: 'cargo',
      args: ['test', '-p', 'futo-notes-sync', '--doc'],
    });
  });
  it('keeps the rest of the workspace and its doctests while routing sync through the bounded runner', () => {
    const h = harness();
    expect(runRustTests({ ...h, scope: 'workspace' })).toBe(0);
    expect(h.calls[0]).toEqual({
      command: 'cargo',
      args: ['test', '--workspace', '--exclude', 'futo-notes-sync'],
    });
    expect(h.calls[1].command).toBe('/tools/cargo-nextest');
    expect(h.calls[2].args).toContain('--doc');
  });
  it.each([
    [100, 1],
    [0, 101],
  ])('propagates the failing phase (%s, %s)', (...statuses) => {
    const h = harness(statuses);
    expect(runRustTests({ ...h, scope: 'sync' })).toBe(statuses.find((code) => code !== 0));
  });
  it('selects only ignored server suites serially and retains literal caller exclusions', () => {
    const args = syncNextestArgs({ integration: true, extraTestArgs: ['--skip', 'slow case'] });
    expect(args).toContain('--run-ignored=only');
    expect(args).toContain('--test-threads=1');
    expect(args.filter((x) => x === '--test')).toHaveLength(2);
    expect(args.slice(-3)).toEqual(['--', '--skip', 'slow case']);
  });
});

describe('nextest bootstrap', () => {
  it('rechecks the exact installed tool after successful setup', () => {
    const calls = [];
    const script = [
      { status: null },
      { status: 0 },
      { status: 0, stdout: 'cargo-nextest 0.9.149 (fixture)' },
    ];
    const binary = ensureNextest('/repo', (command, args) => {
      calls.push({ command, args });
      return script.shift();
    });
    expect(calls[1]).toEqual({ command: 'sh', args: ['/repo/ci/install-nextest.sh'] });
    expect(calls[2].command).toBe(binary);
  });
  it('rejects a zero setup exit if the pinned binary is still missing', () => {
    const script = [{ status: null }, { status: 0 }, { status: null }];
    expect(() => ensureNextest('/repo', () => script.shift())).toThrow(/not executable/);
  });
});

it('resolves a relative install directory against the repository, including paths with spaces', () => {
  vi.stubEnv('NEXTEST_INSTALL_DIR', 'install tools');
  const calls = [];
  const responses = [
    { status: null },
    { status: 0 },
    { status: 0, stdout: 'cargo-nextest 0.9.149 (fixture)' },
  ];
  const binary = ensureNextest('/repo', (command, args, options) => {
    calls.push({ command, args, options });
    return responses.shift();
  });
  expect(binary).toBe(path.resolve('/repo', 'install tools', 'cargo-nextest'));
  expect(calls[1].options.env.NEXTEST_INSTALL_DIR).toBe(path.resolve('/repo', 'install tools'));
});
