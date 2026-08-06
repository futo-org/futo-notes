#!/usr/bin/env node
// Keep a RESTORED cargo `target/` from letting cargo skip a crate whose sources
// changed.
//
// Cargo decides freshness from file mtimes, never from source content. CI
// restores `target/` from a cache keyed only on Cargo.lock, and the restore
// happens AFTER `get_sources`, so a restored artifact can carry an mtime newer
// than the source file it was built from. Cargo then calls the stale rlib fresh
// and links its dependents against it.
//
// That is exactly how pipeline 33129 / job 211040 (`build:android-native` on
// main) failed with 13 errors like `could not find OpenNoteDisposition in
// `sync`` while `crates/futo-notes-sync` plainly exported it: the restored
// target/ held a futo_notes_sync rlib built before open_note.rs existed, the
// trace shows 0 `Compiling [MASKED]-sync` lines, and a bare retry (job 211073,
// 4 sync compiles) went green with no source change.
//
// The fix is to make the mtimes tell the truth. `target/.ci-source-stamp`
// records the commit whose sources the mtimes in this tree correspond to. When
// the stamp disagrees with HEAD, the files that changed between the two commits
// are touched, so cargo rebuilds exactly those crates and reuses every
// third-party artifact — which is the behaviour CI was relying on by accident.
//
// Modes:
//   (default)  repair: report the skew, touch the changed sources, re-stamp.
//   --check    report only; exit 1 when the restored tree is skewed. Used by
//              scripts/ci-cargo-cache-freshness.test.mjs to red-proof the guard.
//
// Deny-by-default: an unstamped or unreadable stamp means "assume skewed" and
// touch every cargo input, which costs a workspace recompile and never a wrong
// build.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// $CI_PROJECT_DIR-anchored in CI (M12); the script's own location covers local
// runs and the tests, which point it at a throwaway repo.
const ROOT = process.env.CI_PROJECT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIR = process.env.CARGO_TARGET_DIR
  ? join(ROOT, process.env.CARGO_TARGET_DIR)
  : join(ROOT, 'target');
const STAMP = join(TARGET_DIR, '.ci-source-stamp');

// Everything cargo reads to decide what to rebuild. Only used for the
// deny-by-default fallback; the stamped path touches the real changed set.
const CARGO_INPUT_PATHS = [
  'crates',
  'apps/tauri',
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  '.cargo',
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function readStamp() {
  if (!existsSync(STAMP)) return null;
  const contents = readFileSync(STAMP, 'utf8').trim();
  return /^[0-9a-f]{40}$/.test(contents) ? contents : null;
}

// A target/ with nothing in it cannot make cargo skip anything.
function targetIsPopulated() {
  try {
    return statSync(TARGET_DIR).isDirectory() && readdirSync(TARGET_DIR).length > 0;
  } catch {
    return false;
  }
}

// Files changed between the cached commit and HEAD, or null when git cannot
// answer (shallow clone, cache from an unrelated branch, rewritten history).
function changedSince(stamp) {
  try {
    git(['cat-file', '-e', `${stamp}^{commit}`]);
    return git(['diff', '--name-only', stamp, 'HEAD']).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function cargoInputFiles() {
  return git(['ls-files', '-z', '--', ...CARGO_INPUT_PATHS])
    .split('\0')
    .filter(Boolean);
}

function touchAll(files) {
  const now = new Date();
  let touched = 0;
  for (const file of files) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue; // deleted between the two commits
    utimesSync(path, now, now);
    touched += 1;
  }
  return touched;
}

function writeStamp(head) {
  mkdirSync(TARGET_DIR, { recursive: true });
  writeFileSync(STAMP, `${head}\n`);
}

const checkOnly = process.argv.includes('--check');
const head = git(['rev-parse', 'HEAD']);
const stamp = readStamp();

if (!targetIsPopulated()) {
  console.log(`cargo cache freshness: no restored target/ — cold build at ${head.slice(0, 8)}`);
  if (!checkOnly) writeStamp(head);
  process.exit(0);
}

if (stamp === head) {
  console.log(`cargo cache freshness: target/ mtimes already match ${head.slice(0, 8)}`);
  process.exit(0);
}

const reason = stamp
  ? `restored target/ was stamped ${stamp.slice(0, 8)}, sources are ${head.slice(0, 8)}`
  : `restored target/ carries no source stamp, sources are ${head.slice(0, 8)}`;

if (checkOnly) {
  console.error(`cargo cache freshness: SKEWED — ${reason}`);
  console.error('  cargo may treat an artifact built from older sources as fresh.');
  console.error('  Run scripts/ci-cargo-cache-freshness.mjs (no --check) to repair.');
  process.exit(1);
}

console.log(`cargo cache freshness: ${reason}`);
const changed = stamp ? changedSince(stamp) : null;
if (changed) {
  console.log(`  touching ${touchAll(changed)} of ${changed.length} changed file(s)`);
} else {
  const files = cargoInputFiles();
  console.log(`  stamped commit unavailable — touching all ${touchAll(files)} cargo input file(s)`);
}
writeStamp(head);
