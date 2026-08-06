// Debt ratchet gate (architecture-hardening.md PKT-8 / R2). Recomputes 4
// "fuzzy" debt counts fresh from the tree and compares them against the
// checked-in baseline (scripts/debt-ratchet.json). The numbers can only go
// down over time:
//
//   node scripts/debt-ratchet.mjs   (just check-debt-ratchet)
//
// Fails on:
//   (a) a count INCREASED — new debt was added; fix it, don't bump the file
//   (b) a count DECREASED — real progress, but scripts/debt-ratchet.json must
//       be updated to the new lower number in the SAME commit, or the ratchet
//       isn't tight (a later change could silently climb back to the old
//       baseline without tripping the gate)
//
// Counts:
//   tauriImportsOutsideShims    — files outside src/lib/platform/** that
//                                 import '@tauri-apps/*' and are not one of
//                                 the dedicated sync shim,
//                                 syncServiceE2ee.ts) — AGENTS.md's "Where logic lives" "OS
//                                 glue" scattered outside a proper shim.
//   invokeCallsOutsideShims     — same scope, but for actual invoke(...)
//                                 call sites rather than the bare import.
//   unlockedDriftRegistryEntries — entries in scripts/drift-registry.json
//                                 with lockStatus 'unlocked'.
//   ignoredPropertyTests        — `#[ignore = "known gap: …"]` tests under
//                                 crates/: property tests that state a real
//                                 production defect and are skipped by
//                                 `cargo test`. No CI job runs `--ignored` for
//                                 these, so this count is the only thing
//                                 stopping them from sitting red forever.
//
// Ceilings (debt-ratchet.json "ceilings"): fixed size caps, NOT ratchets — a
// metric may move freely below its cap (legit rule additions, new plan docs)
// but must never exceed it. Guards the decluttered prose state against silent
// regrowth without punishing normal edits:
//   agentsMdLines            — root AGENTS.md line count (kept lean).
//   docsPlanNonArchiveFiles  — active plan docs in docs/plan/ (excludes archive/).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATCHET_PATH = path.join(ROOT, 'scripts/debt-ratchet.json');
const SRC_DIR = path.join(ROOT, 'src');
const PLATFORM_DIR = path.join(SRC_DIR, 'lib', 'platform') + path.sep;
const REGISTRY_PATH = path.join(ROOT, 'scripts/drift-registry.json');
const CRATES_DIR = path.join(ROOT, 'crates');
const AGENTS_MD_PATH = path.join(ROOT, 'AGENTS.md');
const DOCS_PLAN_DIR = path.join(ROOT, 'docs/plan');

// Sync remains a dedicated shim. Search is projected by LocalNoteStore inside
// src/lib/platform, which scopedFiles already excludes. Everything else touching Tauri is the
// debt this ratchet tracks, even when it's already allowlisted by the
// (separate, stricter) platform-discipline gate as legitimate OS glue.
const DEDICATED_SHIMS = new Set(['src/features/sync/syncServiceE2ee.ts']);

const KNOWN_GAP_IGNORE_RE = /#\[ignore\s*=\s*"known gap:/;
const TAURI_IMPORT_RE = /(?:from\s+['"]|import\(\s*['"])@tauri-apps\//;
const INVOKE_RE = /invoke\s*(?:<[\s\S]*?>)?\s*\(\s*['"][a-zA-Z_][a-zA-Z0-9_]*['"]/g;

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function scopedFiles() {
  return walk(SRC_DIR, ['.ts', '.svelte']).filter(
    (f) =>
      !f.endsWith('.test.ts') &&
      !f.split(path.sep).includes('__mocks__') &&
      !f.startsWith(PLATFORM_DIR),
  );
}

function isDedicatedShim(relPosix) {
  return DEDICATED_SHIMS.has(relPosix);
}

function countTauriImportsOutsideShims() {
  let count = 0;
  for (const file of scopedFiles()) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (isDedicatedShim(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.split('\n').some((line) => TAURI_IMPORT_RE.test(line))) count++;
  }
  return count;
}

function countInvokeCallsOutsideShims() {
  let count = 0;
  for (const file of scopedFiles()) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (isDedicatedShim(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    count += [...text.matchAll(INVOKE_RE)].length;
  }
  return count;
}

function countIgnoredPropertyTests() {
  let count = 0;
  for (const file of walk(CRATES_DIR, ['.rs'])) {
    const text = fs.readFileSync(file, 'utf8');
    count += text.split('\n').filter((line) => KNOWN_GAP_IGNORE_RE.test(line)).length;
  }
  return count;
}

function countUnlockedDriftRegistryEntries() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  return registry.entries.filter((e) => e.lockStatus === 'unlocked').length;
}

function countAgentsMdLines() {
  return (fs.readFileSync(AGENTS_MD_PATH, 'utf8').match(/\n/g) || []).length;
}

// Recursive: a non-recursive readdir would let `mkdir docs/plan/2026 && mv *.md docs/plan/2026/`
// drop the count to 0 while the plans are all still active. Only an `archive/` subtree is exempt.
// Dirent exposes the containing directory as `parentPath` on Node >= 20.12 and as `path` before it.
function countDocsPlanNonArchiveFiles() {
  return fs
    .readdirSync(DOCS_PLAN_DIR, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .filter((e) => {
      const dir = path.relative(DOCS_PLAN_DIR, e.parentPath ?? e.path);
      return !dir.split(path.sep).includes('archive');
    }).length;
}

// Keys present in `baseline` but not in `current` (a retired counter/ceiling
// the script no longer computes — most likely reintroduced by a rebase
// carrying an older copy of the file) and keys `current` computes that
// `baseline` doesn't have (a brand-new metric never locked in) both silently
// compare against `undefined` otherwise (`now > undefined` and
// `now < undefined` are both false), so neither direction of drift ever
// trips the gate. Shared by both the counts and the ceilings comparisons
// below — see commit a6c6e2d5, which fixed this for counts; the same hole
// existed in the ceilings loop until this change.
export function findBaselineKeyMismatches(current, baseline, { noun, ratchetRelPath }) {
  const failures = [];
  for (const key of Object.keys(baseline)) {
    if (!(key in current)) {
      failures.push(
        `'${key}' is in ${ratchetRelPath} but this script no longer computes it — ` +
          `a retired ${noun} came back, most likely from a rebase carrying an older copy of the file. ` +
          `Delete the '${key}' entry.`,
      );
    }
  }
  for (const key of Object.keys(current)) {
    if (!(key in baseline)) {
      failures.push(
        `'${key}' is computed but missing from ${ratchetRelPath} — ` +
          `add it with the current value (${current[key]}) so the ${noun} can hold it.`,
      );
    }
  }
  return failures;
}

export function computeCountFailures(current, baseline, ratchetRelPath) {
  const failures = findBaselineKeyMismatches(current, baseline, {
    noun: 'counter',
    ratchetRelPath,
  });
  for (const key of Object.keys(current)) {
    if (!(key in baseline)) continue; // already reported above
    const now = current[key];
    const was = baseline[key];
    if (now === was) continue;
    if (now > was) {
      failures.push(
        `'${key}' increased from ${was} to ${now} — new debt of this kind is not allowed. ` +
          `Fix the regression (move the offending code behind a shim / lock the registry entry) ` +
          `rather than raising the number in ${ratchetRelPath}.`,
      );
    } else {
      failures.push(
        `'${key}' decreased from ${was} to ${now} — nice, but ${ratchetRelPath} ` +
          `must be updated to lock it in. Run: node -e "const fs=require('fs'),p='${ratchetRelPath}',j=JSON.parse(fs.readFileSync(p));j.counts.${key}=${now};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\\n')" ` +
          `then commit the updated file alongside this change.`,
      );
    }
  }
  return failures;
}

// Ceilings: fixed caps (regrowth guard), not ratchets — only an OVER-cap
// fails for a key present on both sides; an unknown/renamed key must still
// fail rather than comparing `now > undefined` (always false).
export function computeCeilingFailures(currentCeilings, ceilings, ratchetRelPath) {
  const failures = findBaselineKeyMismatches(currentCeilings, ceilings, {
    noun: 'ceiling',
    ratchetRelPath,
  });
  for (const key of Object.keys(currentCeilings)) {
    if (!(key in ceilings)) continue; // already reported above
    const now = currentCeilings[key];
    const cap = ceilings[key];
    if (now > cap) {
      failures.push(
        `'${key}' is ${now}, over its ceiling of ${cap} — the decluttered prose state is regrowing. ` +
          `Trim it back under the cap rather than raising the ceiling in ${ratchetRelPath}.`,
      );
    }
  }
  return failures;
}

function main() {
  const current = {
    tauriImportsOutsideShims: countTauriImportsOutsideShims(),
    invokeCallsOutsideShims: countInvokeCallsOutsideShims(),
    unlockedDriftRegistryEntries: countUnlockedDriftRegistryEntries(),
    ignoredPropertyTests: countIgnoredPropertyTests(),
  };

  const ratchetJson = JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8'));
  const baseline = ratchetJson.counts;
  const ceilings = ratchetJson.ceilings || {};
  const currentCeilings = {
    agentsMdLines: countAgentsMdLines(),
    docsPlanNonArchiveFiles: countDocsPlanNonArchiveFiles(),
  };
  const ratchetRelPath = path.relative(ROOT, RATCHET_PATH);

  const failures = [
    ...computeCountFailures(current, baseline, ratchetRelPath),
    ...computeCeilingFailures(currentCeilings, ceilings, ratchetRelPath),
  ];

  if (failures.length > 0) {
    console.error('Debt ratchet gate FAILED:\n');
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(`\n${failures.length} issue(s).`);
    process.exit(1);
  }

  console.log(
    `Debt ratchet gate OK — ${Object.entries(current)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}; ceilings ${Object.entries(currentCeilings)
      .map(([k, v]) => `${k}=${v}/${ceilings[k]}`)
      .join(', ')}.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
