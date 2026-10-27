// Exercise the real guard with an absolute cache path in the proof worktree.
// The pristine path is absent; the proof seeds its stale artifact before retrying.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const result = spawnSync(process.execPath, ['scripts/ci-cargo-cache-freshness.mjs', '--check'], {
  env: {
    ...process.env,
    CI_PROJECT_DIR: process.cwd(),
    CARGO_TARGET_DIR: resolve('scripts/__fixtures__/cache-redproof-target'),
  },
  stdio: 'inherit',
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
