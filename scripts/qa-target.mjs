#!/usr/bin/env node
// The ONLY sanctioned way to resolve a desktop QA target (a running FUTO Notes
// desktop process) from a port or a PID.
//
//   node scripts/qa-target.mjs list            # every desktop instance, classified
//   node scripts/qa-target.mjs pid <pid>       # verify one PID
//   node scripts/qa-target.mjs port <port>     # verify whoever listens on <port>
//   … pid|port … --json                        # the verdict as one JSON line, for programs
//   node scripts/qa-target.mjs kill            # stop THIS worktree's verified instances
//
// Exit codes: 0 verified · 2 usage · 3 REFUSED (unsafe target) · 4 no such target.
//
// WHY THIS EXISTS. 2026-08-10: a QA agent resolved a PID by matching the
// process name `futo-notes-tauri`, then sent real Cmd+Z keystrokes to it. Every
// build shares that name — `/Applications/FUTO Notes.app/Contents/MacOS/
// futo-notes-tauri` (CFBundleExecutable really is the cargo bin name), the
// per-worktree QA builds, and `just tauri-dev` — and several run at once during
// parallel QA. The lookup resolved to the INSTALLED RELEASE app, which owns the
// user's real, E2EE-synced vault at ~/Documents/futo-notes. The undo landed in
// the wrong app; the vault survived on luck (that instant happened to be a sync
// pull, not a dirty editor + autosave).
//
// So: a name is not an identity. This resolver answers "is this process safe to
// drive?" from things that cannot collide — the executable's real path, the
// worktree list of THIS repo, and the instance's own data dir / vault — and it
// fails CLOSED. Anything it cannot positively prove safe is refused, loudly.
//
// It intentionally does NOT provide any way to send OS-level input. Real
// keystrokes/clicks go to whatever the window server thinks is focused, which
// is not a property of the PID you resolved. Drive the webview instead (the
// debug build's MCP bridge — see .claude/skills/verify/references/desktop.md).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROD_VAULT_RELATIVE,
  classifyExecPath,
  documentsDirFromUserDirs,
  isDesktopExecutableName,
  parseNetstatListener,
  parseTasklist,
  parseWorktreeRoots,
  verifyTarget,
} from './qa-target/classify.mjs';

export {
  DESKTOP_BIN_NAME,
  PROD_VAULT_RELATIVE,
  classifyDataDir,
  classifyExecPath,
  classifyVault,
  documentsDirFromUserDirs,
  isDesktopExecutableName,
  parseNetstatListener,
  parseTasklist,
  parseWorktreeRoots,
  verifyTarget,
} from './qa-target/classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Process inspection (thin OS wrappers)
// ---------------------------------------------------------------------------

function powershell(command) {
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command]).trim();
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    // Without a UTF-8 locale, macOS ps escapes non-ASCII in paths (`·` prints as
    // `M-BM-7`), and the branch-named tauri-dev link would never enumerate.
    env: command === 'ps' ? { ...process.env, LC_ALL: 'en_US.UTF-8' } : process.env,
  });
  return result.status === 0 ? (result.stdout ?? '') : '';
}

// The release app's default vault where the app itself resolves it (vault_location.rs
// default_root): Tauri's document_dir(), else app_data_dir(), joined with futo-notes. On
// Linux that is the `dirs` crate reading user-dirs.dirs, not `xdg-user-dir` or the
// environment. null when Windows does not answer, which refuses every vault (classifyVault).
function releaseVault() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const documents = powershell("[Environment]::GetFolderPath('MyDocuments')");
    return documents ? path.win32.join(documents, 'futo-notes') : null;
  }
  if (process.platform !== 'linux') return path.join(home, PROD_VAULT_RELATIVE);
  const xdg = (name, fallback) =>
    path.isAbsolute(process.env[name] ?? '') ? process.env[name] : path.join(home, fallback);
  let userDirs = '';
  try {
    userDirs = fs.readFileSync(
      path.join(xdg('XDG_CONFIG_HOME', '.config'), 'user-dirs.dirs'),
      'utf8',
    );
  } catch {
    /* no file: the app falls back to its data dir */
  }
  const documents =
    documentsDirFromUserDirs(userDirs, home) ??
    path.join(xdg('XDG_DATA_HOME', '.local/share'), 'com.futo.notes');
  return path.join(documents, 'futo-notes');
}

/** What every verdict is judged against: this repo's worktrees and the user's real vault. */
export function targetContext(selfRoot) {
  return {
    worktreeRoots: worktreeRoots(selfRoot),
    selfRoot,
    home: os.homedir(),
    releaseVault: releaseVault(),
  };
}

export function worktreeRoots(selfRoot) {
  const roots = parseWorktreeRoots(run('git', ['-C', selfRoot, 'worktree', 'list', '--porcelain']));
  return roots.length > 0 ? roots : [selfRoot];
}

export function repoRoot() {
  const top = run('git', ['-C', HERE, 'rev-parse', '--show-toplevel']).trim();
  return top || path.resolve(HERE, '..');
}

// The working directory the process itself was started in — the only correct
// base for a relative argv[0]. Resolving one against OUR cwd is how a sibling
// worktree's instance got reported as this worktree's own (see execPathOf).
function cwdOf(pid) {
  // Windows reports an absolute executable path, so nothing there needs a cwd.
  if (process.platform === 'win32') return null;
  if (process.platform === 'linux') {
    try {
      return fs.realpathSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  const line = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .filter((entry) => entry.startsWith('n'))
    .pop();
  return line ? line.slice(1) : null;
}

// argv[0] is what `pgrep -f` matched on, so it is also what a name-based lookup
// would have believed. We resolve it to an ABSOLUTE real path instead, or return
// null so the caller refuses — a path we cannot resolve proves nothing, and
// letting a relative one through silently reinterprets another process's path in
// our own directory (observed: mr-208's `./target/debug/futo-notes-tauri` was
// reported as this worktree's instance and VERIFIED).
function execPathOf(pid) {
  if (process.platform === 'win32') {
    return (
      powershell(`(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).Path`) || null
    );
  }
  if (process.platform === 'linux') {
    try {
      return fs.realpathSync(`/proc/${pid}/exe`);
    } catch {
      /* fall through to ps */
    }
  }
  // macOS `ps -o comm=` is the full executable path (spaces intact) — prefer it.
  // Otherwise fall back to argv[0], which may be relative and is resolved below;
  // a truncated Linux `comm` is the last resort and will fail to resolve, which
  // is the correct outcome (refusal) rather than a guess.
  const comm = run('ps', ['-p', String(pid), '-o', 'comm=']).trim();
  const argv0 = run('ps', ['-p', String(pid), '-ww', '-o', 'args='])
    .trim()
    .split(/\s+/)[0];
  const candidate = path.isAbsolute(comm) ? comm : argv0 || comm;
  if (!candidate) return null;

  const absolute = path.isAbsolute(candidate)
    ? candidate
    : (() => {
        const base = cwdOf(pid);
        return base ? path.resolve(base, candidate) : null;
      })();
  if (!absolute) return null;

  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function envOf(pid) {
  if (process.platform === 'win32') {
    // No /proc and no `ps -E`: read the environment block out of the process (lib/process-environment.ps1).
    const lines = run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(HERE, 'lib', 'process-environment.ps1'),
      '-ProcessId',
      String(Number(pid)),
    ]);
    if (!lines.trim()) return null;
    return Object.fromEntries(
      lines
        .split(/\r?\n/)
        .filter((line) => line.indexOf('=') > 0)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  }
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      return Object.fromEntries(
        raw
          .split('\0')
          .filter(Boolean)
          .map((entry) => {
            const eq = entry.indexOf('=');
            return [entry.slice(0, eq), entry.slice(eq + 1)];
          }),
      );
    } catch {
      return null;
    }
  }
  // macOS: `ps -E` appends the environment to the command line. Values can
  // contain spaces, so a variable ends where the next `NAME=` begins.
  const blob = run('ps', ['-Eww', '-p', String(pid), '-o', 'command=']);
  if (!blob.trim()) return null;
  const env = {};
  for (const match of blob.matchAll(
    /([A-Za-z_][A-Za-z0-9_]*)=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)/gs,
  )) {
    env[match[1]] = match[2];
  }
  return env;
}

function notesDirOf(dataDir) {
  if (!dataDir) return null;
  try {
    const override = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'notes-dir-override.json'), 'utf8'),
    );
    return typeof override.notesDir === 'string' ? override.notesDir : null;
  } catch {
    return null;
  }
}

export function candidateFor(pid) {
  const execPath = execPathOf(pid);
  const env = envOf(pid);
  const dataDir = env?.FUTO_NOTES_DATA_DIR ?? null;
  return { pid, execPath, dataDir, notesDir: notesDirOf(dataDir), envReadable: env !== null };
}

/**
 * Every running process whose executable is named like the desktop app.
 *
 * Deliberately NOT `ps -o args=` split on whitespace: the production app lives
 * at `/Applications/FUTO Notes.app/…`, and splitting argv on spaces drops the
 * one process this tool most needs to name. macOS `ps -o comm=` prints the full
 * executable path with spaces intact; Linux truncates it, so read /proc there.
 */
export function allCandidatePids() {
  if (process.platform === 'win32') {
    return parseTasklist(run('tasklist', ['/FO', 'CSV', '/NH']))
      .filter(({ image }) => isDesktopExecutableName(image.replace(/\.exe$/i, '')))
      .map(({ pid }) => pid);
  }
  if (process.platform === 'linux') {
    const pids = [];
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (isDesktopExecutableName(path.basename(fs.realpathSync(`/proc/${entry}/exe`)))) {
          pids.push(Number(entry));
        }
      } catch {
        /* process exited, or not ours to read */
      }
    }
    return pids;
  }

  const pids = [];
  for (const line of run('ps', ['-axww', '-o', 'pid=,comm=']).split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    if (isDesktopExecutableName(path.basename(match[2].trim()))) pids.push(Number(match[1]));
  }
  return pids;
}

function pidListeningOn(port) {
  if (process.platform === 'win32') {
    return parseNetstatListener(run('netstat', ['-ano', '-p', 'TCP']), port);
  }
  const viaLsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (viaLsof.length > 0) return viaLsof[0];

  const viaSs = run('ss', ['-ltnpH', `sport = :${port}`]);
  const match = /pid=(\d+)/.exec(viaSs);
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const BANNER = 'qa-target: a process NAME is not an identity — every build ships the same one.';

function printVerdict(result) {
  if (result.verdict === 'verified') {
    console.log(`VERIFIED QA TARGET  pid ${result.pid}`);
    console.log(`  exec:     ${result.execPath}`);
    console.log(`  data dir: ${result.dataDir}`);
    if (result.notesDir) console.log(`  vault:    ${result.notesDir}`);
    for (const warning of result.warnings) console.log(`  warning:  ${warning}`);
    console.log('  Drive it through the webview bridge. Never send OS-level input to a PID.');
    return;
  }
  console.error(`REFUSED  pid ${result.pid}${result.execPath ? ` (${result.execPath})` : ''}`);
  for (const refusal of result.refusals) {
    console.error(`  [${refusal.code}] ${refusal.detail}`);
  }
  console.error(`  ${BANNER}`);
}

const PROD_CODES = new Set(['production-bundle', 'system-install']);

function prodAdvisory(candidates, { exclude = null } = {}) {
  const prod = candidates.filter((candidate) => {
    if (candidate.pid === exclude) return false;
    const code = classifyExecPath(candidate.execPath, { worktreeRoots: [], selfRoot: null }).code;
    return PROD_CODES.has(code);
  });
  if (prod.length === 0) return;
  console.error(
    `NOTE: the installed production app is running (pid ${prod
      .map((candidate) => candidate.pid)
      .join(
        ', ',
      )}). It owns ~/${PROD_VAULT_RELATIVE}. QA never touches it — and never sends OS-level input, which goes to the focused window, not to a PID.`,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage:
  node scripts/qa-target.mjs list          every desktop instance, classified
  node scripts/qa-target.mjs status        THIS worktree's verified instances
  node scripts/qa-target.mjs pid <pid>     verify one PID  (exit 3 = refused)
  node scripts/qa-target.mjs port <port>   verify whoever listens on <port>
    add --json to pid/port for the verdict as one JSON line
  node scripts/qa-target.mjs kill          stop THIS worktree's verified instances`;

function main(argv) {
  const [command, argument] = argv;
  const selfRoot = repoRoot();
  const context = targetContext(selfRoot);

  if (command === 'list') {
    const candidates = allCandidatePids().map(candidateFor);
    if (candidates.length === 0) {
      console.log('no running desktop FUTO Notes process.');
      return 0;
    }
    for (const candidate of candidates) {
      const result = verifyTarget(candidate, context);
      const label = result.verdict === 'verified' ? 'ok      ' : 'REFUSED ';
      const reason = result.refusals.map((refusal) => refusal.code).join(',') || 'this worktree';
      console.log(
        `  ${label} pid ${String(candidate.pid).padStart(7)}  ${reason.padEnd(22)} ${candidate.execPath}`,
      );
    }
    prodAdvisory(candidates);
    return 0;
  }

  // Two separate agents reached for `qa-target status` expecting "the current
  // desktop target" (pc_309aaf57ed30, pc_9f7c0623068c) and got a usage error —
  // a scoped list is what both meant by it.
  if (command === 'status') {
    const candidates = allCandidatePids().map(candidateFor);
    const mine = candidates.filter(
      (candidate) => verifyTarget(candidate, context).verdict === 'verified',
    );
    if (mine.length === 0) {
      console.log('no verified desktop instance of this worktree is running.');
      console.log('Start one with: just tauri-dev');
      return 0;
    }
    for (const candidate of mine) {
      console.log(`ok  pid ${String(candidate.pid).padStart(7)}  ${candidate.execPath}`);
    }
    return 0;
  }

  if (command === 'pid' || command === 'port') {
    const numeric = Number(argument);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      console.error(USAGE);
      return 2;
    }
    const pid = command === 'pid' ? numeric : pidListeningOn(numeric);
    if (!pid) {
      console.error(`nothing is listening on port ${numeric}.`);
      return 4;
    }
    const candidate = candidateFor(pid);
    if (!candidate.execPath) {
      console.error(`REFUSED  pid ${pid} — no such process, or its executable path is unreadable.`);
      return 4;
    }
    const result = verifyTarget(candidate, context);
    if (argv.includes('--json')) {
      console.log(JSON.stringify(result));
      return result.verdict === 'verified' ? 0 : 3;
    }
    printVerdict(result);
    // Its own refusal already named it; this is about the OTHER app that may be
    // running while you look for a QA target.
    prodAdvisory(allCandidatePids().map(candidateFor), { exclude: pid });
    return result.verdict === 'verified' ? 0 : 3;
  }

  if (command === 'kill') {
    const candidates = allCandidatePids().map(candidateFor);
    const mine = candidates.filter(
      (candidate) => verifyTarget(candidate, context).verdict === 'verified',
    );
    for (const candidate of mine) {
      process.kill(candidate.pid, 'SIGTERM');
      console.log(`stopped pid ${candidate.pid} (${candidate.execPath})`);
    }
    if (mine.length === 0) console.log('no verified instance of this worktree is running.');
    const others = candidates.length - mine.length;
    if (others > 0)
      console.log(`left ${others} other instance(s) alone — they are not this worktree's.`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

// Native entrypoint identity also handles directory aliases; imports remain inert.
if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
