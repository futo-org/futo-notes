import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { testRuns } from './test-one.mjs';
import { parseCLI } from 'vitest/node';

describe('just test-one', () => {
  it('keeps path-shaped option values with their flags', () => {
    const runs = testRuns(['packages/editor/src/bridge.test.ts', '-t', 'src/example']);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toEqual(['src/bridge.test.ts', '-t', 'src/example']);
  });
  it('keeps an option operand identical to a positional selector in its original role', () => {
    const editor = 'packages/editor/src/bridge.test.ts';
    const runs = testRuns([editor, '-t', editor, '--maxWorkers=2']);
    expect(runs.map((run) => run.args)).toEqual([
      ['src/bridge.test.ts', '-t', editor, '--maxWorkers=2'],
    ]);
  });
  it.each(
    ['--color', '--allowOnly', '--fileParallelism', '--sequence.shuffle.files'].flatMap((flag) =>
      ['true', 'false'].map((value) => [flag, value]),
    ),
  )('preserves explicit boolean operand %s %s without scheduling a root run', (flag, value) => {
    const args = ['packages/editor/src/bridge.test.ts', flag, value, '--maxWorkers=2'];
    const runs = testRuns(args);
    expect(runs).toHaveLength(1);
    expect(runs[0].args).toEqual(['src/bridge.test.ts', ...args.slice(1)]);
    expect(parseCLI(['vitest', 'run', ...runs[0].args]).options).toEqual(
      parseCLI(['vitest', 'run', ...args]).options,
    );
  });
  it.each([
    ['packages/editor/src/bridge.test.ts', 'spawn-result.test.mjs'],
    ['scripts/lib/spawn-result.test.mjs', 'packages/editor/src/bridge.test.ts'],
    ['--maxWorkers=2', 'packages/editor/src/bridge.test.ts'],
  ])('rejects unsupported mixed/non-first editor selectors with repair guidance: %s', (...args) => {
    expect(() => testRuns(args)).toThrow(/editor selector first.*separate.*just test-one/i);
  });
  it.each([
    ['--maxWorkers', '2'],
    ['--pool', 'forks'],
    ['--', 'literal-after-separator'],
  ])('preserves supported editor option grammar: %s', (...options) => {
    const args = ['packages/editor/src/bridge.test.ts', ...options];
    expect(testRuns(args)[0].args).toEqual(['src/bridge.test.ts', ...options]);
  });
  it('passes existing root invocations through verbatim, including editor-shaped option values', () => {
    for (const args of [
      [],
      ['-t', 'root test'],
      ['scripts/lib/spawn-result.test.mjs', '-t', 'packages/editor/src/bridge.test.ts'],
    ]) {
      expect(testRuns(args)).toHaveLength(1);
      expect(testRuns(args)[0].args).toBe(args);
    }
  });
  it.each([
    ['packages/editor/src/bridge.test.ts'],
    ['scripts/lib/spawn-result.test.mjs'],
    ['./packages/editor/src/bridge.test.ts'],
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

  it('rejects mixed selectors before starting any test runner', () => {
    const result = spawnSync(
      'just',
      ['test-one', 'packages/editor/src/bridge.test.ts', 'spawn-result.test.mjs', '--maxWorkers=2'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('separate just test-one commands');
    expect(result.stdout).not.toContain('RUN');
  });
});
