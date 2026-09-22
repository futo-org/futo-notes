// The FUTO coin is modelled in Blender and exported to three files that three
// different shells render. None of them can be regenerated in CI — the runners
// have no Blender, and putting one there to rebuild a static ornament would be
// absurd. So this gate proves the cheap half instead, which is the half that
// actually goes wrong:
//
//   1. The exports came from the `build-coin.py` that is on disk right now.
//      Editing the model and forgetting to run `just coin` is the whole failure
//      mode — the script would describe a coin nobody is shipping.
//   2. Nobody hand-edited an export afterwards. They are generated files, and
//      the source of truth is the script (AGENTS.md M8).
//
// Both are hashes, recorded by the build into assets/coin/manifest.json.
//
// It also proves a third thing, which needs no Blender at all: the studio half
// of the coin is pure arithmetic, so `scripts/lib/studio-env.mjs` can rerun it
// and the result can be compared against the .hdr on disk. That is what makes
// the tuner's copy of the room (`just coin-tuner`) a locked duplicate rather
// than a hopeful one.
//
//   just coin         regenerate (needs Blender)
//   just coin-tuner   play with the numbers
//   just coin-check   this gate

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildStudioEnvironment, compareToHdr, decodeRadianceHdr } from './lib/studio-env.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COIN = path.join(ROOT, 'assets/coin');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/// A .usdz is a zip, and a zip stamps every entry with the time it was written.
/// Its bytes therefore differ on every rebuild while its contents do not, so it
/// is hashed by its entries — exactly as build-coin.py does.
function contentDigest(file) {
  const absolute = path.join(COIN, file);
  if (!file.endsWith('.usdz')) return sha256(readFileSync(absolute));

  // `unzip -Z1` lists entry names without extracting, and `unzip -p` streams one
  // entry's bytes. Both ship with the zip tools every dev box and CI image has,
  // which beats adding a zip dependency for one ornament.
  const names = execFileSync('unzip', ['-Z1', absolute], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const digest = createHash('sha256');
  for (const name of names) {
    digest.update(Buffer.from(name, 'utf8'));
    digest.update(execFileSync('unzip', ['-p', absolute, name], { maxBuffer: 64 * 1024 * 1024 }));
  }
  return digest.digest('hex');
}

const problems = [];
const manifest = JSON.parse(readFileSync(path.join(COIN, 'manifest.json'), 'utf8'));

const sourceOnDisk = sha256(readFileSync(path.join(COIN, manifest.source)));
if (sourceOnDisk !== manifest.sourceSha256) {
  problems.push(
    `assets/coin/${manifest.source} has changed since the coin was last exported.\n` +
      `    manifest records ${manifest.sourceSha256}\n` +
      `    on disk          ${sourceOnDisk}\n` +
      `    The shipped coin is NOT the one this script describes. Run: just coin`,
  );
}

for (const [file, expected] of Object.entries(manifest.outputs)) {
  const actual = contentDigest(file);
  if (actual !== expected) {
    problems.push(
      `assets/coin/${file} does not match the manifest.\n` +
        `    manifest records ${expected}\n` +
        `    on disk          ${actual}\n` +
        `    Generated files are never edited in place (M8). Edit build-coin.py, then: just coin`,
    );
  }
}

// Android cannot read the .hdr; it reads a cubemap `cmgen` prefiltered from it.
// That derivation is the one step a person can silently skip — change the studio
// in Blender, rerun the Blender half, and Android keeps reflecting the OLD room
// while the other two shells reflect the new one. Nothing about that fails to
// load, so nothing but this catches it.
if (manifest.ibl !== undefined) {
  const hdrNow = manifest.outputs[manifest.ibl.from];
  if (hdrNow !== manifest.ibl.fromSha256) {
    problems.push(
      `assets/coin/studio-env-ibl.ktx was prefiltered from a different ${manifest.ibl.from}.\n` +
        `    the .ktx was built from ${manifest.ibl.fromSha256}\n` +
        `    the .hdr on disk is     ${hdrNow}\n` +
        `    Android would reflect the old studio. Run: node scripts/build-coin-ibl.mjs`,
    );
  }
}

// The studio is generated from about thirty lines of numpy, and
// scripts/lib/studio-env.mjs runs the same arithmetic so the coin tuner can
// rebuild the room while a slider moves. Two copies of one formula, so this
// holds them together: build the room here, decode the shipped .hdr, and insist
// they agree to within the file format's own rounding. RGBE truncates to a
// per-pixel step, so a faithful port lands just under 1 step and a changed
// formula lands far above it.
const HDR_TOLERANCE_QUANTA = 1;
try {
  const decoded = decodeRadianceHdr(
    new Uint8Array(readFileSync(path.join(COIN, 'studio-env.hdr'))),
  );
  const drift = compareToHdr(buildStudioEnvironment(), decoded);
  if (!(drift.worst < HDR_TOLERANCE_QUANTA)) {
    problems.push(
      `scripts/lib/studio-env.mjs no longer reproduces assets/coin/studio-env.hdr.\n` +
        `    worst disagreement ${drift.worst.toFixed(3)} quantisation steps ` +
        `(at row ${drift.row}, column ${drift.column}); anything from ` +
        `${HDR_TOLERANCE_QUANTA} up is a real difference in the arithmetic.\n` +
        `    The studio lives in TWO places (drift-registry \`coin-studio-environment\`):\n` +
        `    assets/coin/build-coin.py \`build_environment\` and that module's SHIPPED +\n` +
        `    buildStudioEnvironment. Change both in one commit, then: just coin`,
    );
  }
} catch (error) {
  problems.push(
    `assets/coin/studio-env.hdr could not be checked against scripts/lib/studio-env.mjs:\n` +
      `    ${error.message}`,
  );
}

if (problems.length > 0) {
  console.error('Coin asset gate FAILED:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(
  `Coin asset gate OK — ${Object.keys(manifest.outputs).length} exports match build-coin.py ` +
    `(Blender ${manifest.blender}${manifest.ibl === undefined ? '' : `, ${manifest.ibl.tool}`}), ` +
    `and studio-env.mjs rebuilds the studio to within a quantisation step.`,
);
