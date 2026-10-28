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
export function git(args, cwd = ROOT, env = process.env) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function gitOrThrow(args, cwd = ROOT, env = process.env) {
  const result = git(args, cwd, env);
  if (result.status !== 0) {
    // `||`, not `??`: an empty stderr must fall through to error.message, or a
    // spawn-level failure (ENOBUFS, ENOENT) reports its reason as nothing at all.
    const reason =
      result.stderr || result.error?.message || `exited with signal ${result.signal ?? 'unknown'}`;
    throw new Error(`git ${args.join(' ')} failed:\n${reason}`);
  }
  return result.stdout.trim();
}

// Build a commit from the current on-disk source with a disposable index.
// `git stash create` both omits untracked source and can rewrite the real
// index's cache-tree extension. An alternate index preserves staged/unstaged
// distinctions in the caller while Git retains symlink and executable modes.
export function resolveBase() {
  const head = gitOrThrow(['rev-parse', 'HEAD']);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-redproof-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    // The current index knows about newly force-added ignored source that
    // HEAD cannot supply. Git resolves a linked worktree's private index path.
    const index = path.resolve(ROOT, gitOrThrow(['rev-parse', '--git-path', 'index']));
    if (fs.existsSync(index)) fs.copyFileSync(index, env.GIT_INDEX_FILE);
    else gitOrThrow(['read-tree', head], ROOT, env);
    gitOrThrow(['add', '-A', '--', '.'], ROOT, env);
    const tree = gitOrThrow(['write-tree'], ROOT, env);
    if (tree === gitOrThrow(['rev-parse', `${head}^{tree}`])) {
      return { rev: head, label: `HEAD ${head.slice(0, 9)}` };
    }
    const rev = gitOrThrow(
      [
        '-c',
        'user.name=Gate redproof',
        '-c',
        'user.email=gate-redproof@example.invalid',
        'commit-tree',
        tree,
        '-p',
        head,
        '-m',
        'Gate redproof working-tree snapshot',
      ],
      ROOT,
      env,
    );
    return { rev, label: `working tree of HEAD ${head.slice(0, 9)} (including untracked source)` };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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
