import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkIosBuildSpace } from './ios-build-space.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('checks the closest existing target ancestor and explains scoped disk recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'ios-build-space-'));
  dirs.push(root);
  let probed;
  expect(() =>
    checkIosBuildSpace({
      targetDir: join(root, 'not-created', 'target'),
      minFreeGiB: 2,
      statfs: (path) => {
        probed = path;
        return { bavail: 1024, bsize: 1024 };
      },
    }),
  ).toThrow(/just wt gc --sizes/);
  expect(probed).toBe(root);
});

it('accepts enough space without touching the target', () => {
  const root = mkdtempSync(join(tmpdir(), 'ios-build-space-'));
  dirs.push(root);
  const result = checkIosBuildSpace({
    targetDir: root,
    minFreeGiB: 2,
    statfs: () => ({ bavail: 4, bsize: 1024 ** 3 }),
  });
  expect(result.availableGiB).toBe(4);
});

it.each([0, -1, NaN, Infinity])(
  'rejects an invalid minimum %s instead of silently bypassing preflight',
  (minimum) => {
    expect(() => checkIosBuildSpace({ targetDir: tmpdir(), minFreeGiB: minimum })).toThrow(
      'positive',
    );
  },
);
