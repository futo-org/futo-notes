// Throwaway-worktree plumbing for the gate red-proofs (scripts/gate-redproofs.mjs).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// Worktree plumbing
// ---------------------------------------------------------------------------

// maxBuffer: `ls-files --others` enumerates EVERY untracked file, and CI
// restores $CI_PROJECT_DIR/.pnpm-store (not gitignored) into the build dir —
// a pnpm content-addressable store is ~25 MB of path text, 25x Node's 1 MB
// default. On overflow spawnSync SIGTERMs git and returns status=null with an
// empty stderr, which used to surface as a blank "git ... failed:".
export function git(args, cwd = ROOT) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function gitOrThrow(args, cwd = ROOT) {
  const result = git(args, cwd);
  if (result.status !== 0) {
    // `||`, not `??`: an empty stderr must fall through to error.message, or a
    // spawn-level failure (ENOBUFS, ENOENT) reports its reason as nothing at all.
    const reason =
      result.stderr || result.error?.message || `exited with signal ${result.signal ?? 'unknown'}`;
    throw new Error(`git ${args.join(' ')} failed:\n${reason}`);
  }
  return result.stdout.trim();
}

// The commit the proof worktree is built from: the working tree's tracked
// state when it is dirty (so a gate you just edited is the one under test),
// HEAD when it is clean. Untracked files are never included — reported, not
// hidden.
export function resolveBase() {
  const head = gitOrThrow(['rev-parse', '--short', 'HEAD']);
  const status = gitOrThrow(['status', '--porcelain']).split('\n').filter(Boolean);
  const trackedEdits = status.some((line) => !line.startsWith('??'));
  const untracked = gitOrThrow(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean);

  if (!trackedEdits) return { rev: head, label: `HEAD ${head}`, untracked };

  const stash = git(['stash', 'create']);
  const rev = stash.status === 0 ? stash.stdout.trim() : '';
  if (!rev) {
    return {
      rev: head,
      label: `HEAD ${head} — the working tree has tracked edits but 'git stash create' produced nothing, so those edits are NOT covered`,
      untracked,
    };
  }
  return {
    rev,
    label: `working tree of HEAD ${head} (via git stash create ${rev.slice(0, 9)})`,
    untracked,
  };
}

export function createWorktree(rev) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-gate-redproof-'));
  const wt = path.join(dir, 'wt');
  gitOrThrow(['worktree', 'add', '--detach', wt, rev]);
  // tsx-based gates need the workspace's installed toolchain. A symlink is
  // enough: every gate walker skips a directory named node_modules, and it is
  // gitignored so `git clean` leaves it alone.
  const realModules = path.join(ROOT, 'node_modules');
  if (fs.existsSync(realModules)) fs.symlinkSync(realModules, path.join(wt, 'node_modules'));
  return { dir, wt };
}

// No `git worktree prune` here: `remove --force` already deregisters this
// worktree, and a blanket prune would also deregister every OTHER worktree
// whose directory has since vanished (this repo carries agent scratchpads
// under /tmp) — a side effect a throwaway proof worktree has no business having.
export function destroyWorktree({ dir, wt }) {
  git(['worktree', 'remove', '--force', wt]);
  fs.rmSync(dir, { recursive: true, force: true });
}

// `.gitignore` lists `node_modules/` as a DIRECTORY pattern, and the
// toolchain link this harness drops in is a symlink — which git sees as a
// file, reports as untracked, and would fail the cleanliness assertion below.
export const IGNORED_IN_PROOF_WORKTREE = new Set(['node_modules']);

export function revert(wt) {
  // Unstage first: a proof whose violation only exists once git TRACKS the path
  // (a committed symlink, say) has to `git add` it, and neither `checkout` nor
  // `clean` touches the index — the staged entry would survive into the next
  // proof and trip the cleanliness assertion below.
  gitOrThrow(['reset', '-q'], wt);
  gitOrThrow(['checkout', '--', '.'], wt);
  gitOrThrow(['clean', '-fdq', '-e', 'node_modules'], wt);
  const leftover = gitOrThrow(['status', '--porcelain'], wt)
    .split('\n')
    .filter((line) => line !== '' && !IGNORED_IN_PROOF_WORKTREE.has(line.slice(3).trim()))
    .join('\n');
  if (leftover !== '') {
    throw new Error(
      `proof worktree did not revert cleanly — later proofs would run against contaminated state:\n${leftover}`,
    );
  }
}
