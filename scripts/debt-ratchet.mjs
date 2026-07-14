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
//                                 syncServiceE2ee.ts) — AGENTS.md §4's "OS
//                                 glue" scattered outside a proper shim.
//   invokeCallsOutsideShims     — same scope, but for actual invoke(...)
//                                 call sites rather than the bare import.
//   specGapsCount               — `> **Gap:**` lines recorded in
//                                 docs/spec/GAPS.md (spec-gaps.mjs output).
//   unlockedDriftRegistryEntries — entries in scripts/drift-registry.json
//                                 with lockStatus 'unlocked'.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATCHET_PATH = path.join(ROOT, 'scripts/debt-ratchet.json');
const SRC_DIR = path.join(ROOT, 'src');
const PLATFORM_DIR = path.join(SRC_DIR, 'lib', 'platform') + path.sep;
const GAPS_PATH = path.join(ROOT, 'docs/spec/GAPS.md');
const REGISTRY_PATH = path.join(ROOT, 'scripts/drift-registry.json');

// Sync remains a dedicated shim. Search is projected by LocalNoteStore inside
// src/lib/platform, which scopedFiles already excludes. Everything else touching Tauri is the
// debt this ratchet tracks, even when it's already allowlisted by the
// (separate, stricter) platform-discipline gate as legitimate OS glue.
const DEDICATED_SHIMS = new Set(['src/features/sync/syncServiceE2ee.ts']);

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

function countSpecGaps() {
  const text = fs.readFileSync(GAPS_PATH, 'utf8');
  return text.split('\n').filter((line) => line.startsWith('- [')).length;
}

function countUnlockedDriftRegistryEntries() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  return registry.entries.filter((e) => e.lockStatus === 'unlocked').length;
}

const current = {
  tauriImportsOutsideShims: countTauriImportsOutsideShims(),
  invokeCallsOutsideShims: countInvokeCallsOutsideShims(),
  specGapsCount: countSpecGaps(),
  unlockedDriftRegistryEntries: countUnlockedDriftRegistryEntries(),
};

const baseline = JSON.parse(fs.readFileSync(RATCHET_PATH, 'utf8')).counts;

const failures = [];
for (const key of Object.keys(current)) {
  const now = current[key];
  const was = baseline[key];
  if (now === was) continue;
  if (now > was) {
    failures.push(
      `'${key}' increased from ${was} to ${now} — new debt of this kind is not allowed. ` +
        `Fix the regression (move the offending code behind a shim / lock the registry entry / ` +
        `close the spec gap) rather than raising the number in ${path.relative(ROOT, RATCHET_PATH)}.`,
    );
  } else {
    failures.push(
      `'${key}' decreased from ${was} to ${now} — nice, but ${path.relative(ROOT, RATCHET_PATH)} ` +
        `must be updated to lock it in. Run: node -e "const fs=require('fs'),p='${path.relative(ROOT, RATCHET_PATH)}',j=JSON.parse(fs.readFileSync(p));j.counts.${key}=${now};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\\n')" ` +
        `then commit the updated file alongside this change.`,
    );
  }
}

if (failures.length > 0) {
  console.error('Debt ratchet gate FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\n${failures.length} issue(s).`);
  process.exit(1);
}

console.log(
  `Debt ratchet gate OK — ${Object.entries(current)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}.`,
);
