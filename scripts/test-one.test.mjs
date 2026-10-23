import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { testRuns } from './test-one.mjs';

describe('just test-one', () => {
  it('keeps path-shaped option values with their flags', () => {
    const runs = testRuns(['packages/editor/src/bridge.test.ts', '-t', 'src/example']);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toEqual(['src/bridge.test.ts', '-t', 'src/example']);
  });
  it('keeps an option operand identical to a positional selector in its original role', () => {
    const editor = 'packages/editor/src/bridge.test.ts';
    const root = 'scripts/lib/spawn-result.test.mjs';
    const runs = testRuns([editor, root, '-t', editor, '--maxWorkers=2']);
    expect(runs.map((run) => run.args)).toEqual([
      ['src/bridge.test.ts', '-t', editor, '--maxWorkers=2'],
      [root, '-t', editor, '--maxWorkers=2'],
    ]);
  });
  it.each([
    ['packages/editor/src/bridge.test.ts'],
    ['scripts/lib/spawn-result.test.mjs'],
    ['./packages/editor/src/bridge.test.ts', 'scripts/lib/spawn-result.test.mjs'],
    ['packages/editor/src/bridge.test.ts', 'spawn-result.test.mjs'],
  ])('runs explicit paths through their owning config: %s', (...files) => {
    const result = spawnSync('just', ['test-one', ...files, '--maxWorkers=2'], {
      encoding: 'utf8',
    });
    expect(result.stderr).not.toContain('No test files found');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Test Files\s+1 passed/);
    expect((result.stdout.match(/Test Files/g) ?? []).length).toBe(files.length);
  });

  it('propagates a failed package test selection', () => {
    const result = spawnSync(
      'just',
      ['test-one', 'packages/editor/src/missing.test.ts', '--maxWorkers=2'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No test files found');
  });
});
