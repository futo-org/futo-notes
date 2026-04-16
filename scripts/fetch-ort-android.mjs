#!/usr/bin/env node
// Fetch prebuilt `libonnxruntime.so` for Android, matching the ORT version
// expected by our `ort`/`ort-sys` Rust crate, and drop it into the Tauri
// Android project's jniLibs directory so the APK picks it up.
//
// We pull Microsoft's official `onnxruntime-android` AAR from Maven Central —
// it's just a zip file containing `jni/<abi>/libonnxruntime.so` plus unused
// Java classes.
//
// The resulting .so files are NOT committed to git (see .gitignore). Run this
// script before building an Android APK, or CI will fail at link time.
//
// Usage:
//   node scripts/fetch-ort-android.mjs
//   node scripts/fetch-ort-android.mjs --version 1.24.2 --abis arm64-v8a,armeabi-v7a
//   ORT_VERSION=1.24.2 ORT_ABIS=arm64-v8a node scripts/fetch-ort-android.mjs

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, unlink, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Pin to the ORT version ort-sys 2.0.0-rc.12 targets (see
// ~/.cargo/registry/.../ort-sys-2.0.0-rc.12/build/download/dist.txt). If you
// bump `ort` in Cargo.toml, bump this in lockstep.
const DEFAULT_VERSION = '1.24.2';
const DEFAULT_ABIS = ['arm64-v8a'];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const JNI_LIBS = join(
  REPO_ROOT,
  'apps/tauri/src-tauri/gen/android/app/src/main/jniLibs',
);
const CACHE_DIR = join(tmpdir(), 'stonefruit-ort-android-cache');

function parseArgs() {
  const args = { version: process.env.ORT_VERSION || DEFAULT_VERSION, abis: null };
  const tokens = process.argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--version') args.version = tokens[++i];
    else if (t === '--abis') args.abis = tokens[++i].split(',');
    else if (t === '--help' || t === '-h') {
      console.log(
        'Usage: node scripts/fetch-ort-android.mjs [--version 1.24.2] [--abis arm64-v8a,armeabi-v7a]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${t}`);
      process.exit(1);
    }
  }
  if (!args.abis) {
    args.abis = (process.env.ORT_ABIS || DEFAULT_ABIS.join(',')).split(',');
  }
  return args;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function downloadTo(url, destPath) {
  // We stream to a .part file so a network drop doesn't leave a corrupt
  // file under the real name.
  const part = `${destPath}.part`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  await mkdir(dirname(destPath), { recursive: true });
  const file = createWriteStream(part);
  await new Promise((resolveStream, rejectStream) => {
    const reader = resp.body.getReader();
    const pump = () =>
      reader.read().then(({ done, value }) => {
        if (done) {
          file.end();
          file.on('close', resolveStream);
          file.on('error', rejectStream);
          return;
        }
        if (!file.write(value)) file.once('drain', pump);
        else pump();
      }).catch(rejectStream);
    pump();
  });
  await rename(part, destPath);
}

async function ensureAar(version) {
  await mkdir(CACHE_DIR, { recursive: true });
  const aarName = `onnxruntime-android-${version}.aar`;
  const aarPath = join(CACHE_DIR, aarName);
  const aarUrl = `https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/${version}/${aarName}`;
  const sha1Url = `${aarUrl}.sha1`;

  // Maven publishes a SHA-1 sidecar file. We verify the cached copy against
  // that sidecar before reusing it — protects against partial downloads from
  // a previous run and mirrors what `gradle` does under the hood.
  console.log(`Fetching SHA-1 from ${sha1Url}...`);
  const sha1Resp = await fetch(sha1Url);
  if (!sha1Resp.ok)
    throw new Error(`Could not fetch SHA-1 sidecar: HTTP ${sha1Resp.status}`);
  const expectedSha1 = (await sha1Resp.text()).trim().split(/\s+/)[0];

  if (await exists(aarPath)) {
    const actualSha1 = createHash('sha1')
      .update(await readFile(aarPath))
      .digest('hex');
    if (actualSha1 === expectedSha1) {
      console.log(`Cached AAR matches SHA-1 (${expectedSha1.slice(0, 12)}...)`);
      return aarPath;
    }
    console.log('Cached AAR failed SHA-1 check — re-downloading.');
    await rm(aarPath);
  }

  console.log(`Downloading ${aarName} (~30 MB)...`);
  await downloadTo(aarUrl, aarPath);
  const actualSha1 = createHash('sha1')
    .update(await readFile(aarPath))
    .digest('hex');
  if (actualSha1 !== expectedSha1) {
    await rm(aarPath);
    throw new Error(
      `SHA-1 mismatch on ${aarName}: got ${actualSha1}, expected ${expectedSha1}`,
    );
  }
  return aarPath;
}

async function extractSoForAbis(aarPath, abis) {
  // .aar is a zip. Use the system `unzip` — it's ubiquitous on dev machines
  // (pnpm, Android Studio, and most CI images ship it). Avoid pulling a Node
  // zip dependency just for this helper.
  for (const abi of abis) {
    const soInsideAar = `jni/${abi}/libonnxruntime.so`;
    const destDir = join(JNI_LIBS, abi);
    const destPath = join(destDir, 'libonnxruntime.so');

    await mkdir(destDir, { recursive: true });

    // Atomic write: extract to tmp, then rename.
    const tmpExtract = join(CACHE_DIR, `extract-${abi}`);
    await rm(tmpExtract, { recursive: true, force: true });
    await mkdir(tmpExtract, { recursive: true });

    console.log(`Extracting ${soInsideAar}...`);
    try {
      execFileSync('unzip', ['-q', '-j', aarPath, soInsideAar, '-d', tmpExtract], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (e) {
      throw new Error(
        `Failed to extract ${soInsideAar} (is ${abi} bundled in this ORT release?): ${e.message}`,
      );
    }

    const extracted = join(tmpExtract, 'libonnxruntime.so');
    if (!(await exists(extracted))) {
      throw new Error(`Extraction produced no file for ${abi}`);
    }

    // /tmp is often on tmpfs or a different filesystem from the repo, which
    // makes rename() fail with EXDEV. Copy instead; cleanup tmp after.
    await copyFile(extracted, destPath);
    await unlink(extracted);
    const sz = (await stat(destPath)).size;
    console.log(
      `  → ${destPath.replace(REPO_ROOT + '/', '')} (${(sz / 1024 / 1024).toFixed(1)} MiB)`,
    );
  }
}

async function ensureGitignore() {
  const gitignore = join(JNI_LIBS, '.gitignore');
  const body = [
    '# Prebuilt libonnxruntime.so files are fetched by scripts/fetch-ort-android.mjs',
    '# and must match the ORT version in ort-sys. Do not commit them to git.',
    '**/libonnxruntime.so',
    '',
  ].join('\n');
  if (!(await exists(gitignore))) {
    await mkdir(JNI_LIBS, { recursive: true });
    await writeFile(gitignore, body);
    console.log(`Wrote ${gitignore.replace(REPO_ROOT + '/', '')}`);
  }
}

async function main() {
  const args = parseArgs();
  console.log(
    `Fetching ONNX Runtime ${args.version} for ABIs: ${args.abis.join(', ')}`,
  );
  const aar = await ensureAar(args.version);
  await extractSoForAbis(aar, args.abis);
  await ensureGitignore();
  console.log('Done.');
}

main().catch((e) => {
  console.error('fetch-ort-android failed:', e);
  process.exit(1);
});
