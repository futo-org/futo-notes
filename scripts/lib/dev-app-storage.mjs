// `just wt gc`'s sweep of the per-branch browser storage `just tauri-dev` leaves in ~/Library.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { allCandidatePids, candidateFor } from '../qa-target.mjs';
import { staleDevAppNames } from './slot.mjs';

// An unbundled `just tauri-dev` process has no bundle id, so WebKit names its
// storage after the branch-named executable (apps/tauri/src-tauri/src/dev_app_name.rs).
const DEV_APP_STORAGE_ROOTS = ['WebKit', 'Caches'].map((name) =>
  path.join(os.homedir(), 'Library', name),
);

export function sweepDevAppStorage(liveBranches, { apply }) {
  if (process.platform !== 'darwin') return;
  // ~/Library is per user, not per repo: a running instance from another clone,
  // or one whose worktree has since switched branch, still owns its folders.
  const running = new Set(
    allCandidatePids()
      .map((pid) => candidateFor(pid).execPath)
      .filter(Boolean)
      .map((execPath) => path.basename(execPath)),
  );
  const stale = DEV_APP_STORAGE_ROOTS.flatMap((root) => {
    const names = fs.existsSync(root) ? fs.readdirSync(root) : [];
    return staleDevAppNames(names, liveBranches)
      .filter((name) => !running.has(name))
      .map((name) => path.join(root, name));
  });
  if (stale.length === 0) return;
  console.error(`dev-app storage of branches no worktree has checked out (${stale.length}):`);
  for (const folder of stale) {
    if (apply) fs.rmSync(folder, { recursive: true, force: true });
    console.error(`  ${apply ? 'removed' : 'would remove'} ${folder}`);
  }
}
