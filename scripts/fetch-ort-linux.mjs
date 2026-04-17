#!/usr/bin/env node
// Fetch prebuilt `libonnxruntime.so` for Linux (x86_64) from Microsoft's
// official GitHub release tarball, matching the ORT version expected by our
// `ort`/`ort-sys` Rust crate.
//
// Why this script exists: ort-sys' default prebuilt Linux binary references
// glibc 2.38+ symbols (__isoc23_strtoll/strtoul) that older distros don't
// export. Microsoft's own Linux tarball is built on CentOS 7 with glibc 2.17
// as the floor, so it links cleanly against every distro we target and has
// no __isoc23_* references. We ship the .so alongside the binary and load it
// dynamically via ORT_DYLIB_PATH at app startup.
//
// The resulting .so is NOT committed to git. Run this before building the
// Tauri app on Linux or CI will fail at link time.
//
// Usage:
//   node scripts/fetch-ort-linux.mjs
//   node scripts/fetch-ort-linux.mjs --version 1.24.2
//   ORT_VERSION=1.24.2 node scripts/fetch-ort-linux.mjs

import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Pin to the ORT version ort-sys 2.0.0-rc.12 targets. If you bump `ort` in
// Cargo.toml, bump this in lockstep (and the Android/iOS fetch scripts).
const DEFAULT_VERSION = '1.24.2';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const GEN_DIR = join(REPO_ROOT, 'apps/tauri/src-tauri/gen/linux');
const SO_PATH = join(GEN_DIR, 'libonnxruntime.so');
const CACHE_DIR = join(tmpdir(), 'stonefruit-ort-linux-cache');

// Also mirror into target/{debug,release}/ when those exist so `cargo tauri
// dev`, `cargo test`, and un-bundled cargo builds can resolve it via the
// sibling-of-exe fallback in the Rust init code.
const TARGET_DIRS = [
  join(REPO_ROOT, 'target/debug'),
  join(REPO_ROOT, 'target/release'),
];

function parseArgs() {
  const args = { version: process.env.ORT_VERSION || DEFAULT_VERSION };
  const tokens = process.argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--version') args.version = tokens[++i];
    else if (t === '--help' || t === '-h') {
      console.log('Usage: node scripts/fetch-ort-linux.mjs [--version 1.24.2]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${t}`);
      process.exit(1);
    }
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
  const part = `${destPath}.part`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  await mkdir(dirname(destPath), { recursive: true });
  const file = createWriteStream(part);
  await new Promise((resolveStream, rejectStream) => {
    const reader = resp.body.getReader();
    const pump = () =>
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            file.end();
            file.on('close', resolveStream);
            file.on('error', rejectStream);
            return;
          }
          if (!file.write(value)) file.once('drain', pump);
          else pump();
        })
        .catch(rejectStream);
    pump();
  });
  await rename(part, destPath);
}

async function ensureTarball(version) {
  await mkdir(CACHE_DIR, { recursive: true });
  const tarName = `onnxruntime-linux-x64-${version}.tgz`;
  const tarPath = join(CACHE_DIR, tarName);
  const tarUrl = `https://github.com/microsoft/onnxruntime/releases/download/v${version}/${tarName}`;

  if (await exists(tarPath)) {
    console.log(`Using cached ${tarName}`);
    return tarPath;
  }

  console.log(`Downloading ${tarName} (~15 MB) from ${tarUrl}...`);
  await downloadTo(tarUrl, tarPath);
  return tarPath;
}

async function extractSo(tarPath, version) {
  await mkdir(GEN_DIR, { recursive: true });
  const tmpExtract = join(CACHE_DIR, 'extract');
  await rm(tmpExtract, { recursive: true, force: true });
  await mkdir(tmpExtract, { recursive: true });

  const tarDir = `onnxruntime-linux-x64-${version}`;
  const soRelPath = `${tarDir}/lib/libonnxruntime.so.${version}`;

  console.log(`Extracting ${soRelPath}...`);
  try {
    execFileSync('tar', ['-xzf', tarPath, '-C', tmpExtract, soRelPath], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch (e) {
    throw new Error(`tar extract failed: ${e.message}`);
  }

  const extracted = join(tmpExtract, soRelPath);
  if (!(await exists(extracted))) {
    throw new Error(`Extraction produced no file at ${extracted}`);
  }

  await copyFile(extracted, SO_PATH);
  const sz = (await stat(SO_PATH)).size;
  console.log(
    `  → ${SO_PATH.replace(REPO_ROOT + '/', '')} (${(sz / 1024 / 1024).toFixed(1)} MiB)`,
  );

  for (const dir of TARGET_DIRS) {
    if (await exists(dir)) {
      const dest = join(dir, 'libonnxruntime.so');
      await copyFile(SO_PATH, dest);
      console.log(`  → ${dest.replace(REPO_ROOT + '/', '')}`);
    }
  }

  await rm(tmpExtract, { recursive: true, force: true });
}

async function ensureGitignore() {
  const gitignore = join(GEN_DIR, '.gitignore');
  if (await exists(gitignore)) return;
  const body = [
    '# Prebuilt libonnxruntime.so fetched by scripts/fetch-ort-linux.mjs.',
    '# Must match the ORT version in ort-sys. Do not commit to git.',
    'libonnxruntime.so',
    '',
  ].join('\n');
  await writeFile(gitignore, body);
  console.log(`Wrote ${gitignore.replace(REPO_ROOT + '/', '')}`);
}

async function main() {
  const args = parseArgs();
  console.log(`Fetching ONNX Runtime ${args.version} for linux-x64`);
  const tar = await ensureTarball(args.version);
  await extractSo(tar, args.version);
  await ensureGitignore();
  console.log('Done.');
}

main().catch((e) => {
  console.error('fetch-ort-linux failed:', e);
  process.exit(1);
});
