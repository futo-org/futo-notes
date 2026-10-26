import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEditorBenchGateFixture } from '../__fixtures__/gate-redproofs/editor-bench-artifacts.mjs';

afterEach(() => vi.unstubAllEnvs());

it.each(['PW_RUN_ID', 'FUTO_VERIFICATION_DIR'])(
  'reads fresh redirected failures under %s',
  (key) => {
    vi.stubEnv('PW_RUN_ID', '');
    vi.stubEnv('FUTO_VERIFICATION_DIR', '');
    vi.stubEnv(key, key === 'PW_RUN_ID' ? 'current' : '/fixture/verification');
    const result = runEditorBenchGateFixture({ fail: true });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('redproof-artifact-failure');
  },
);

it.each(['PW_RUN_ID', 'FUTO_VERIFICATION_DIR'])(
  'refuses stale evidence after child crash under %s',
  (key) => {
    vi.stubEnv('PW_RUN_ID', '');
    vi.stubEnv('FUTO_VERIFICATION_DIR', '');
    vi.stubEnv(key, key === 'PW_RUN_ID' ? 'current' : '/fixture/verification');
    const result = runEditorBenchGateFixture({ crash: true });
    expect(result.code, result.output).toBe(2);
    expect(result.output).toContain('fixture child crashed');
    expect(result.output).not.toContain('ACCEPT');
  },
);

it('accepts a fresh passing report', () => {
  const result = runEditorBenchGateFixture();
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('ACCEPT');
});

const GATE = 'scripts/perf/editor-bench-gate.mjs';
const run = (...args) =>
  spawnSync(process.execPath, ['--experimental-strip-types', GATE, ...args], { encoding: 'utf8' });

describe('editor-bench-gate arguments', () => {
  it('refuses --regression-only with --accept before running the bench', () => {
    // CI's mode must never rewrite the baseline; a crash or bad argument is 2.
    const r = run('--regression-only', '--accept');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('never writes the baseline');
    expect(r.stdout).not.toContain('count passes');
  });

  it('rejects an unknown argument with exit 2', () => {
    const r = run('--no-such-flag');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unrecognized argument');
  });
});
