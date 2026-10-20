// Pure classification for qa-target.mjs: given a candidate's executable path, data dir and
// vault, decide whether it is safe to drive. No process inspection happens here.
import path from 'node:path';

import { DEV_APP_FILE_NAME_PREFIX } from '../lib/slot.mjs';

// The desktop binary name every build shares — the whole reason this file
// exists. Used ONLY to enumerate candidates for classification, never to decide
// that a candidate is safe.
export const DESKTOP_BIN_NAME = 'futo-notes-tauri';

// `just tauri-dev` on macOS re-executes the debug binary from a hard link named
// for its branch (see devAppFileName), so that name enumerates too. Like the
// bin name, it only makes a candidate; the path checks below decide.
export function isDesktopExecutableName(fileName) {
  return fileName === DESKTOP_BIN_NAME || fileName.startsWith(DEV_APP_FILE_NAME_PREFIX);
}

// The release app's default vault (M3). Never a QA target, and the single most
// important string in this file.
export const PROD_VAULT_RELATIVE = path.join('Documents', 'futo-notes');

const SYSTEM_INSTALL_PREFIXES = [
  '/Applications/',
  '/System/',
  '/usr/bin/',
  '/usr/local/bin/',
  '/usr/local/lib/',
  '/opt/',
  '/snap/',
  '/var/lib/flatpak/',
];

// ---------------------------------------------------------------------------
// Pure classification (unit-tested in scripts/qa-target.test.mjs)
// ---------------------------------------------------------------------------

export function parseWorktreeRoots(porcelainText) {
  return porcelainText
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

function isInside(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Classify an executable path. `ok: true` only for a debug binary built inside
 * THIS worktree — everything else is refused with a code that says why.
 */
export function classifyExecPath(execPath, { worktreeRoots, selfRoot }) {
  if (!execPath) {
    return {
      ok: false,
      code: 'exec-path-unknown',
      detail: 'could not read the process executable path — refusing rather than guessing',
    };
  }
  // Backstop for the false-ACCEPT direction: a relative path is interpreted
  // against whatever cwd asks the question, so `./target/debug/futo-notes-tauri`
  // from ANOTHER worktree resolves inside THIS one and passes every check below.
  // Callers resolve relative paths against the process's own cwd; if one still
  // arrives here, refuse.
  if (!path.isAbsolute(execPath)) {
    return {
      ok: false,
      code: 'exec-path-not-absolute',
      detail: `${execPath} is not an absolute path, so it cannot identify a process — resolved against a different cwd it would name a different binary entirely.`,
    };
  }

  if (execPath.includes('.app/Contents/MacOS/') || execPath.startsWith('/Applications/')) {
    return {
      ok: false,
      code: 'production-bundle',
      detail: `${execPath} is an INSTALLED APPLICATION BUNDLE — the user's production app, which owns the real vault (~/${PROD_VAULT_RELATIVE}). Never drive it, never send it input, never kill it.`,
    };
  }
  if (SYSTEM_INSTALL_PREFIXES.some((prefix) => execPath.startsWith(prefix))) {
    return {
      ok: false,
      code: 'system-install',
      detail: `${execPath} is a system-installed build (a released package), not a QA build. It resolves the real vault (~/${PROD_VAULT_RELATIVE}).`,
    };
  }

  // Longest match wins: this repo keeps its worktrees UNDER the main checkout
  // (.claude/worktrees/*), so the main root contains every worktree path and a
  // first-match lookup would attribute every instance to the main checkout.
  const owningRoot = worktreeRoots
    .filter((root) => isInside(root, execPath))
    .sort((a, b) => b.length - a.length)[0];
  if (!owningRoot) {
    return {
      ok: false,
      code: 'outside-repo',
      detail: `${execPath} is not inside any git worktree of this repo (${worktreeRoots.length} known). An unknown build has an unknown vault.`,
    };
  }
  if (/[/\\]target[/\\]release[/\\]/.test(execPath)) {
    return {
      ok: false,
      code: 'release-profile',
      detail: `${execPath} is a RELEASE-profile build. Release config carries the production identifier and resolves the real vault (M3) even when built in a worktree.`,
    };
  }
  if (!/[/\\]target[/\\]debug[/\\]/.test(execPath)) {
    return {
      ok: false,
      code: 'not-a-debug-build',
      detail: `${execPath} is inside ${owningRoot} but not under target/debug/ — only debug builds carry the dev identifier and the QA test hooks.`,
    };
  }
  // Exact owner, not containment: run from the main checkout, `isInside` would
  // accept every nested worktree's instance as "mine".
  if (selfRoot && path.resolve(owningRoot) !== path.resolve(selfRoot)) {
    return {
      ok: false,
      code: 'other-worktree',
      detail: `${execPath} belongs to worktree ${owningRoot}, not this one (${selfRoot}). It is another session's QA instance — driving it corrupts their run. Re-run this resolver from ${owningRoot} if the instance really is yours.`,
    };
  }
  return { ok: true, code: 'worktree-debug-build', owningRoot, detail: null };
}

/**
 * Classify the instance's data dir (FUTO_NOTES_DATA_DIR). Fails closed: an
 * unreadable or unset data dir means we cannot prove which vault the instance
 * writes to, so it is not a QA target.
 */
export function classifyDataDir(dataDir, { worktreeRoots, envReadable = true }) {
  // Reported separately from "unset": claiming a process has no
  // FUTO_NOTES_DATA_DIR when we simply could not read its environment would be
  // the same class of false statement as the -newermt all-clear.
  if (!envReadable) {
    return {
      ok: false,
      code: 'env-unreadable',
      detail:
        'the process environment could not be read, so its vault cannot be proved isolated. This normally means the process belongs to another user — which also means it is not yours to drive. (macOS reads it via `ps -E`, Linux via /proc/<pid>/environ.)',
    };
  }
  if (!dataDir) {
    return {
      ok: false,
      code: 'data-dir-unset',
      detail:
        'the process has no FUTO_NOTES_DATA_DIR, so its vault is whatever the build default resolves to — machine-global at best, the real vault at worst. Relaunch it with FUTO_NOTES_DATA_DIR="$WORKTREE_ROOT/.tauri-data".',
    };
  }
  if (!worktreeRoots.some((root) => isInside(root, dataDir))) {
    return {
      ok: false,
      code: 'data-dir-outside-repo',
      detail: `FUTO_NOTES_DATA_DIR=${dataDir} is not inside any worktree of this repo — app state (including sync watermarks) lives outside QA isolation.`,
    };
  }
  return { ok: true, code: 'data-dir-in-worktree', detail: null };
}

/**
 * Classify the vault the instance actually writes notes into (the data dir's
 * notes-dir-override.json, when present). The production vault is a hard
 * refusal; any other vault outside the worktree is a warning, because
 * `just tauri-dev` in the MAIN checkout legitimately uses the machine-global
 * ~/Documents/fake-notes — shared between parallel sessions, so QA should not
 * write there, but it is not the user's data.
 */
export function classifyVault(notesDir, { worktreeRoots, home }) {
  if (!notesDir) return { ok: true, code: 'vault-unknown', warning: null, detail: null };

  const prodVault = path.join(home, PROD_VAULT_RELATIVE);
  if (isInside(prodVault, notesDir) || isInside(notesDir, prodVault)) {
    return {
      ok: false,
      code: 'production-vault',
      detail: `this instance's vault is ${notesDir}, which is the USER'S REAL VAULT (${prodVault}). Stop. Do not drive, write to, or kill this process.`,
    };
  }
  if (!worktreeRoots.some((root) => isInside(root, notesDir))) {
    return {
      ok: true,
      code: 'vault-outside-worktree',
      warning: `vault ${notesDir} is outside this repo — it is shared with every other session on this machine. Fine to look at, do not seed fixtures into it.`,
      detail: null,
    };
  }
  return { ok: true, code: 'vault-in-worktree', warning: null, detail: null };
}

/** The whole verdict for one candidate process. Refusals accumulate. */
export function verifyTarget(candidate, context) {
  const refusals = [];
  const warnings = [];

  const exec = classifyExecPath(candidate.execPath, context);
  if (!exec.ok) refusals.push(exec);

  // Only meaningful for one of our own builds; a foreign executable is already
  // refused above and its env tells us nothing.
  if (exec.ok) {
    const dataDir = classifyDataDir(candidate.dataDir, {
      ...context,
      envReadable: candidate.envReadable ?? true,
    });
    if (!dataDir.ok) refusals.push(dataDir);
  }

  const vault = classifyVault(candidate.notesDir, context);
  if (!vault.ok) refusals.push(vault);
  else if (vault.warning) warnings.push(vault.warning);

  return {
    pid: candidate.pid,
    execPath: candidate.execPath,
    dataDir: candidate.dataDir ?? null,
    notesDir: candidate.notesDir ?? null,
    verdict: refusals.length === 0 ? 'verified' : 'REFUSED',
    refusals,
    warnings,
  };
}
