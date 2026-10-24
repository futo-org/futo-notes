#!/usr/bin/env node
// Read-only storage preflight before native Rust builds: inspect the actual
// target volume (or its nearest existing ancestor), never delete a cache.
import { existsSync, statfsSync } from 'node:fs';
import path from 'node:path';

export function checkIosBuildSpace({ targetDir, minFreeGiB = 2, statfs = statfsSync }) {
  if (!Number.isFinite(minFreeGiB) || minFreeGiB <= 0) {
    throw new Error('FUTO_IOS_MIN_FREE_GIB must be a positive number');
  }
  let probe = path.resolve(targetDir);
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error(`No existing ancestor for target ${targetDir}`);
    probe = parent;
  }
  const stats = statfs(probe);
  const availableGiB = (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
  if (!Number.isFinite(availableGiB)) throw new Error(`Could not read free space for ${probe}`);
  if (availableGiB < minFreeGiB) {
    throw new Error(
      `iOS build storage: ${availableGiB.toFixed(1)} GiB free at ${probe}; minimum ${minFreeGiB} GiB.\n` +
        `Target: ${path.resolve(targetDir)}\n` +
        'Inspect disk usage and run just wt gc --sizes (dry run) before choosing cleanup.\n' +
        'Do not delete a shared target/ cache or user data; obtain approval for expensive cleanup.\n' +
        'A cold build may need more than this minimum. Set FUTO_IOS_MIN_FREE_GIB for the planned build.',
    );
  }
  return { probe, availableGiB, minFreeGiB };
}

if (import.meta.main) {
  try {
    const result = checkIosBuildSpace({
      targetDir: process.argv[2] || process.env.CARGO_TARGET_DIR || 'target',
      minFreeGiB: Number(process.env.FUTO_IOS_MIN_FREE_GIB || 2),
    });
    console.log(
      `iOS build storage: ${result.availableGiB.toFixed(1)} GiB free at ${result.probe} (minimum ${result.minFreeGiB} GiB)`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
