import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  STALE_TEMP_MIN_AGE_MS,
  isStaleAtomicTemp,
  sweepStaleAtomicTemps,
  type TempSweepFS,
} from './staleAtomicTemps';

describe('stale temp cleanup (RC-101)', () => {
  const NOW = 1_800_000_000_000;
  const old = `.sf-tmp-${NOW - STALE_TEMP_MIN_AGE_MS - 1}-0`;
  const fresh = `.sf-tmp-${NOW - 5_000}-1`;

  it('recognises only its own temp names, and only once they are old', () => {
    expect(isStaleAtomicTemp(old, NOW)).toBe(true);
    expect(isStaleAtomicTemp(`.sf-tmp-${NOW - STALE_TEMP_MIN_AGE_MS}-3`, NOW)).toBe(true);
    // Young enough to be a live write, or from the future (a clock step).
    expect(isStaleAtomicTemp(fresh, NOW)).toBe(false);
    expect(isStaleAtomicTemp(`.sf-tmp-${NOW + 60_000}-0`, NOW)).toBe(false);
    // Not our pattern: the engine's temps, other .sf-* files, user files.
    expect(isStaleAtomicTemp(`.sf-tmp-1234-${NOW - 90_000}-2`, NOW)).toBe(false);
    expect(isStaleAtomicTemp('.sf-bak-1000000000000-0', NOW)).toBe(false);
    expect(isStaleAtomicTemp(`${old}.md`, NOW)).toBe(false);
    expect(isStaleAtomicTemp(`x${old}`, NOW)).toBe(false);
    expect(isStaleAtomicTemp('.sf-tmp-source', NOW)).toBe(false);
    expect(isStaleAtomicTemp('.app-config.json', NOW)).toBe(false);
    expect(isStaleAtomicTemp('sf-tmp-1000000000000-0', NOW)).toBe(false);
  });

  it('removes stale temps from a real directory and leaves everything else', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-sweep-test-'));
    try {
      const keep = ['.app-config.json', 'note.md', fresh, '.sf-tmp-source', `${old}.md`];
      for (const name of [...keep, old]) await fs.writeFile(path.join(dir, name), 'x');
      await fs.mkdir(path.join(dir, `.sf-tmp-${NOW - 999_999}-7`)); // a directory of that name

      const real: TempSweepFS = {
        async readDir(p) {
          const entries = await fs.readdir(p, { withFileTypes: true });
          return entries.map((e) => ({ name: e.name, isFile: e.isFile() }));
        },
        remove: (p) => fs.rm(p),
      };
      const removed = await sweepStaleAtomicTemps(dir, real, NOW);

      expect(removed).toEqual([old]);
      const left = (await fs.readdir(dir)).sort();
      expect(left).toEqual([...keep, `.sf-tmp-${NOW - 999_999}-7`].sort());
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('never throws: a missing directory or a failing remove is skipped', async () => {
    const gone: TempSweepFS = {
      readDir: async () => {
        throw new Error('ENOENT');
      },
      remove: async () => {},
    };
    await expect(sweepStaleAtomicTemps('/nope', gone, NOW)).resolves.toEqual([]);

    const locked: TempSweepFS = {
      readDir: async () => [
        { name: old, isFile: true },
        { name: `.sf-tmp-${NOW - 200_000}-1`, isFile: true },
      ],
      remove: async (p) => {
        if (p.endsWith(old)) throw new Error('EBUSY');
      },
    };
    await expect(sweepStaleAtomicTemps('/v', locked, NOW)).resolves.toEqual([
      `.sf-tmp-${NOW - 200_000}-1`,
    ]);
  });
});
