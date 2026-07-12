// Drift registry gate (architecture-hardening.md PKT-8 / R1). AGENTS.md §12's
// "same logic in >=2 places" watchlist as code, deny-by-default:
// scripts/drift-registry.json enumerates every PERMITTED duplicate concept —
// each copy's file + a pattern that must still be found there, and the lock
// (fixture/generated-file/test) that catches drift, or an explicit
// 'unlocked'/'partial' status when no lock exists yet.
//
//   node scripts/drift-check.mjs   (just check-drift)
//
// Fails on:
//   (a) a registered copy whose file is missing, or whose pattern no longer
//       matches (stale registry — the code moved/changed shape)
//   (b) a registered lock file that doesn't exist, or a lockStatus that's
//       inconsistent with whether locks are registered (a 'locked' entry with
//       zero locks, or an 'unlocked' entry that lists locks)
//   (c) for entries with a 'scan' block: a NEW file — outside the registered
//       copies — matching the concept's detection pattern (a fresh
//       image-extension array, a new validateServerUrl definition, a new
//       MAX_TITLE_LENGTH=200 literal, ...)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'scripts/drift-registry.json');

const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  '.git',
  '.build',
  '.build-device',
  '.build-device-release',
  'build',
  'Generated',
  'Pods',
]);

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const failures = [];
const rel = (p) => path.relative(ROOT, p);

for (const entry of registry.entries) {
  const { concept } = entry;
  const copies = entry.copies ?? [];
  const locks = entry.locks ?? [];
  const registeredLocations = new Set(copies.map((c) => c.location));

  // (a) every registered copy exists where claimed, pattern still matches.
  for (const copy of copies) {
    const full = path.join(ROOT, copy.location);
    if (!fs.existsSync(full)) {
      failures.push(
        `[${concept}] registered copy '${copy.location}' does not exist — stale registry ` +
          `entry (file moved/deleted). Update drift-registry.json.`,
      );
      continue;
    }
    const text = fs.readFileSync(full, 'utf8');
    const re = new RegExp(copy.pattern, copy.flags ?? '');
    if (!re.test(text)) {
      failures.push(
        `[${concept}] pattern ${JSON.stringify(copy.pattern)} no longer matches in ` +
          `'${copy.location}' — the code changed shape, or the registry is stale. Update the ` +
          `pattern (don't delete the entry) if the copy still exists in spirit.`,
      );
    }
  }

  // (b) every declared lock file exists; lockStatus is consistent.
  for (const lock of locks) {
    const full = path.join(ROOT, lock.path);
    if (!fs.existsSync(full)) {
      failures.push(
        `[${concept}] registered lock '${lock.path}' does not exist — stale registry entry.`,
      );
    }
  }
  if (entry.lockStatus === 'locked' && locks.length === 0) {
    failures.push(
      `[${concept}] lockStatus is 'locked' but no locks are registered — either add the ` +
        `lock file(s), or downgrade lockStatus to 'partial'/'unlocked'.`,
    );
  }
  if (entry.lockStatus === 'unlocked' && locks.length > 0) {
    failures.push(
      `[${concept}] lockStatus is 'unlocked' but ${locks.length} lock(s) are registered — ` +
        `upgrade lockStatus to 'locked' or 'partial'.`,
    );
  }

  // (c) no NEW unregistered occurrence of the concept's detection pattern.
  if (entry.scan) {
    const { dirs, extensions, pattern, flags } = entry.scan;
    const files = dirs.flatMap((d) => walk(path.join(ROOT, d), extensions));
    const scanRe = new RegExp(pattern, flags ?? '');
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (!scanRe.test(text)) continue;
      const fileRel = rel(file);
      if (!registeredLocations.has(fileRel)) {
        failures.push(
          `[${concept}] NEW unregistered occurrence of this concept's pattern found in ` +
            `'${fileRel}' — register it in drift-registry.json (if a genuinely new permitted ` +
            `copy), or consolidate it into an existing copy instead of duplicating.`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error('Drift registry gate FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\n${failures.length} issue(s).`);
  process.exit(1);
}

const locked = registry.entries.filter((e) => e.lockStatus === 'locked').length;
const partial = registry.entries.filter((e) => e.lockStatus === 'partial').length;
const unlocked = registry.entries.filter((e) => e.lockStatus === 'unlocked').length;
console.log(
  `Drift registry gate OK — ${registry.entries.length} concept(s) registered ` +
    `(${locked} locked, ${partial} partial, ${unlocked} unlocked).`,
);
