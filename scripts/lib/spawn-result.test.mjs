import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { formatSpawnFailure } from './spawn-result.mjs';

// A missing binary leaves stdout/stderr undefined, so the old
// `${result.stderr || result.stdout}` rendered the literal string "undefined"
// and named neither the command nor ENOENT (pc_925496b61ef9).
describe('formatSpawnFailure', () => {
  it('names the missing command instead of rendering undefined', () => {
    const result = spawnSync('futo-definitely-not-a-real-binary', ['x'], { encoding: 'utf8' });
    const message = formatSpawnFailure(result, 'bun');
    expect(message).toContain('bun');
    expect(message).toContain('ENOENT');
    expect(message).not.toContain('undefined');
  });

  it('passes a real failure through with its stderr', () => {
    const result = spawnSync('sh', ['-c', 'echo boom >&2; exit 3'], { encoding: 'utf8' });
    expect(formatSpawnFailure(result, 'bun')).toBe('boom');
  });

  it('still says something when a failure produced no output at all', () => {
    const result = spawnSync('sh', ['-c', 'exit 4'], { encoding: 'utf8' });
    expect(formatSpawnFailure(result, 'bun')).toContain('status 4');
  });
});
