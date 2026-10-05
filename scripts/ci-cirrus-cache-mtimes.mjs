#!/usr/bin/env node
// Re-impose a truthful mtime ORDER on caches Cirrus just restored.
//
// The Cirrus agent untars a restored cache with plain `os.Create` + `Chmod` and
// never applies the tar header's ModTime (cirrus-cli
// internal/agent/targz/targz.go, writeNewFile). So every file in a restored
// `target/` or `~/.cargo/registry` comes back stamped with the moment the untar
// happened to reach it — i.e. in filesystem-walk order, which has nothing to do
// with the build order cargo reconstructs from mtimes.
//
// That silently guts the cache. `target/aarch64-apple-ios/...` is walked before
// `target/release-ffi/...`, so the HOST-side build-script and proc-macro
// outputs come back NEWER than the per-target artifacts that consume them, and
// cargo dutifully rebuilds every build-script crate, every proc-macro, and
// everything downstream. Measured on job 257386 (test:ios-native, warm cache):
// 659 crates recompiled on a full cache hit, and the crates that DID survive
// were exactly the plain library crates with no build.rs and no proc-macro —
// 10:04 of script time against 10:28 cold, for 102s of cache overhead.
//
// The fix is to flatten the ordering instead of trying to reproduce it. Each
// directory argument gets one uniform timestamp, and later arguments get later
// timestamps, so the caller states the dependency order once:
//
//   node scripts/ci-cirrus-cache-mtimes.mjs "$HOME/.cargo/registry" target
//
// registry sources < target artifacts < the working tree (which the VM sync
// wrote just now). Cargo treats equal mtimes as fresh and strictly-newer inputs
// as dirty, so within a tier nothing is spuriously stale, across tiers the
// order is the true one, and the workspace's own sources still win over every
// restored artifact — a workspace crate is never wrongly skipped.
//
// Backdating is safe in the one direction that matters: it can only make cargo
// MORE willing to reuse an artifact whose inputs are in an earlier tier, and
// registry sources are immutable per version (a bumped dependency unpacks into
// a new directory that has no artifact at all, so it still builds).
//
// Missing directories are skipped: a cache miss is normal and is not an error.

import { lutimesSync, opendirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// One hour between tiers: far beyond any filesystem timestamp granularity, and
// still comfortably in the past so the freshly synced working tree outranks
// every restored file.
const TIER_GAP_MS = 60 * 60 * 1000;
const BASE_EPOCH_MS = Date.UTC(2001, 0, 1);

export function stampTree(root, whenMs) {
  const when = new Date(whenMs);
  let stamped = 0;
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    let handle;
    try {
      handle = opendirSync(dir);
    } catch {
      continue; // vanished or unreadable — nothing to stamp
    }
    const dirs = [];
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) dirs.push(path);
        try {
          // lutimes, not utimes: a dangling symlink in a restored tree must not
          // throw, and following one could stamp something outside the tree.
          lutimesSync(path, when, when);
          stamped += 1;
        } catch {
          // Unreadable entry; the rebuild it causes is the safe outcome.
        }
      }
    } finally {
      handle.closeSync();
    }
    stack.push(...dirs);
  }

  try {
    lutimesSync(root, when, when);
    stamped += 1;
  } catch {
    // Same as above.
  }

  return stamped;
}

export function stampTiers(roots, baseEpochMs = BASE_EPOCH_MS) {
  const results = [];
  roots.forEach((root, tier) => {
    let present = false;
    try {
      present = statSync(root).isDirectory();
    } catch {
      present = false;
    }
    if (!present) {
      results.push({ root, tier, skipped: true, stamped: 0 });
      return;
    }
    const whenMs = baseEpochMs + tier * TIER_GAP_MS;
    results.push({ root, tier, skipped: false, stamped: stampTree(root, whenMs), whenMs });
  });
  return results;
}

function main(argv) {
  const roots = argv.filter((a) => !a.startsWith('-'));
  if (roots.length === 0) {
    console.error('usage: ci-cirrus-cache-mtimes.mjs <oldest-dir> [<newer-dir> ...]');
    process.exit(2);
  }

  const started = Date.now();
  for (const result of stampTiers(roots)) {
    if (result.skipped) {
      console.log(`cirrus cache mtimes: ${result.root} absent (cache miss) — nothing to stamp`);
    } else {
      console.log(
        `cirrus cache mtimes: ${result.root} -> tier ${result.tier} ` +
          `(${new Date(result.whenMs).toISOString()}), ${result.stamped} entries`,
      );
    }
  }
  console.log(`cirrus cache mtimes: done in ${Date.now() - started}ms`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
