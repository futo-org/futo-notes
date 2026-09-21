// Android's renderer cannot use assets/coin/studio-env.hdr directly.
//
// three.js and RealityKit both prefilter an equirectangular map into a
// roughness mip chain at load time. Filament does not: it wants that work done
// ahead of time, as a KTX cubemap plus the spherical-harmonic coefficients for
// the diffuse term. `cmgen`, which ships with the Filament release, is the tool
// that does it — so this turns the one studio every shell shares into the one
// form Android needs, and nothing about the LOOK is decided here.
//
// cmgen is downloaded from Maven against the checksums pinned in
// scripts/coin-ibl-pin.json and cached, the same way the sync harness pins its
// server release. Its version MUST track the Filament dependency in
// apps/android/app/build.gradle.kts.
//
//   node scripts/build-coin-ibl.mjs            regenerate studio-env-ibl.ktx
//   node scripts/build-coin-ibl.mjs --refresh  print a new pin block
//
// CI never runs this: the .ktx is committed, and `just coin-check` verifies it
// against the .hdr it was built from.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const COIN = path.join(ROOT, 'assets/coin');
const PIN = JSON.parse(readFileSync(path.join(ROOT, 'scripts/coin-ibl-pin.json'), 'utf8'));

/// The cubemap's base resolution. The source is a 256x128 equirect of a studio
/// with no fine detail in it, and the result is only ever seen as a blurred
/// reflection in a 160dp object — 64 keeps the mip chain long enough for the
/// roughness range the coin uses while costing a tenth of what 256 does.
const CUBEMAP_SIZE = 64;

const KEY = `${platform() === 'win32' ? 'win32' : platform()}-${arch() === 'arm64' ? 'arm64' : 'x64'}`;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

if (process.argv.includes('--refresh')) {
  const binaries = {};
  for (const [key, entry] of Object.entries(PIN.binaries)) {
    const url = `${PIN.artifactUrl}/${PIN.version}/${entry.asset}`;
    const response = await fetch(`${url}.sha256`);
    binaries[key] = { asset: entry.asset, sha256: (await response.text()).trim() };
  }
  console.log(JSON.stringify({ ...PIN, binaries }, null, 2));
  process.exit(0);
}

const pinned = PIN.binaries[KEY];
if (pinned === undefined) {
  console.error(
    `No pinned cmgen for ${KEY}. Filament publishes linux-x64, darwin-arm64 and win32-x64.\n` +
      `  The committed assets/coin/studio-env-ibl.ktx is what ships, so this only blocks\n` +
      `  REGENERATING the Android environment on this machine.`,
  );
  process.exit(1);
}

// Cached outside the repo: it is a 4MB binary, it is the same for every
// worktree on the machine, and it is not ours to vendor.
const cache = path.join(homedir(), '.cache/futo-notes/cmgen', PIN.version);
const binary = path.join(cache, pinned.asset);

if (!existsSync(binary)) {
  const url = `${PIN.artifactUrl}/${PIN.version}/${pinned.asset}`;
  console.log(`==> downloading cmgen ${PIN.version} (${KEY})`);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`cmgen download failed: ${response.status} ${response.statusText}\n  ${url}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== pinned.sha256) {
    console.error(
      `cmgen checksum mismatch — refusing to run it.\n` +
        `  pinned ${pinned.sha256}\n  got    ${actual}\n  ${url}`,
    );
    process.exit(1);
  }
  mkdirSync(cache, { recursive: true });
  // Write then rename, so two worktrees racing this cannot leave a half file
  // behind that every later run then trusts.
  const staging = `${binary}.${process.pid}.part`;
  writeFileSync(staging, bytes);
  chmodSync(staging, 0o755);
  renameSync(staging, binary);
}

// cmgen names its outputs after the deploy directory, and writes a skybox we do
// not want: the coin is composited onto the app's card, not onto a rendered
// sky. Deploy into a scratch directory and keep only the IBL.
const scratch = path.join(COIN, '.ibl-staging');
rmSync(scratch, { recursive: true, force: true });
execFileSync(
  binary,
  [
    `--deploy=${scratch}`,
    '--format=ktx',
    `--size=${CUBEMAP_SIZE}`,
    path.join(COIN, 'studio-env.hdr'),
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

// cmgen names its outputs after the deploy directory, minus any leading dot,
// so the exact filename is its business and not ours to predict.
const produced = readdirSync(scratch)
  .filter((name) => name.endsWith('_ibl.ktx'))
  .map((name) => path.join(scratch, name));
if (produced.length !== 1) {
  console.error(`expected exactly one *_ibl.ktx in ${scratch}, found ${produced.length}`);
  process.exit(1);
}
const ktx = readFileSync(produced[0]);
writeFileSync(path.join(COIN, 'studio-env-ibl.ktx'), ktx);
rmSync(scratch, { recursive: true, force: true });

// Record it in the manifest the coin gate reads, together with the hash of the
// .hdr it came from: that pairing is what catches an environment that was
// changed in Blender and never re-prefiltered for Android.
const manifestPath = path.join(COIN, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.outputs['studio-env-ibl.ktx'] = sha256(ktx);
manifest.ibl = {
  tool: `cmgen ${PIN.version}`,
  size: CUBEMAP_SIZE,
  from: 'studio-env.hdr',
  fromSha256: manifest.outputs['studio-env.hdr'],
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `[coin] wrote assets/coin/studio-env-ibl.ktx (${(ktx.length / 1024).toFixed(0)} KB, ` +
    `cubemap ${CUBEMAP_SIZE}, cmgen ${PIN.version})`,
);
