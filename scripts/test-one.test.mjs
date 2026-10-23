import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('just test-one', () => {
  it.each([
    ['packages/editor/src/bridge.test.ts'],
    ['scripts/lib/spawn-result.test.mjs'],
    ['./packages/editor/src/bridge.test.ts', 'scripts/lib/spawn-result.test.mjs'],
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
