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
//   just coin         regenerate (needs Blender)
//   just coin-check   this gate

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

if (problems.length > 0) {
  console.error('Coin asset gate FAILED:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(
  `Coin asset gate OK — ${Object.keys(manifest.outputs).length} exports match build-coin.py ` +
    `(Blender ${manifest.blender}${manifest.ibl === undefined ? '' : `, ${manifest.ibl.tool}`}).`,
);
