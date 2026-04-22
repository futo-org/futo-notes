#!/usr/bin/env node
// Fetch prebuilt ONNX Runtime xcframework for iOS, matching the ORT version
// expected by our `ort`/`ort-sys` Rust crate.
//
// Microsoft publishes iOS static frameworks as CocoaPod archives. We download
// the archive, extract onnxruntime.xcframework, and cache it locally. The
// resulting path must be set as `ORT_IOS_XCFWK_PATH` before building:
//
//   export ORT_IOS_XCFWK_PATH=$(node scripts/fetch-ort-ios.mjs)
//   cd apps/tauri && cargo tauri ios build --debug
//
// The xcframework is NOT committed to git (see .gitignore). Run this script
// before building an iOS IPA, or the linker will fail.
//
// Usage:
//   node scripts/fetch-ort-ios.mjs
//   node scripts/fetch-ort-ios.mjs --version 1.24.2

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Pin to the ORT version ort-sys 2.0.0-rc.12 targets. If you bump `ort` in
// Cargo.toml, bump this in lockstep (same as fetch-ort-android.mjs).
const DEFAULT_VERSION = '1.24.2';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const CACHE_DIR = join(tmpdir(), 'futo-notes-ort-ios-cache');
// Store the extracted xcframework alongside the Xcode project so it's easy
// to reference and gitignore.
const XCFWK_DIR = join(REPO_ROOT, 'apps/tauri/src-tauri/gen/apple');

function parseArgs() {
  const args = { version: process.env.ORT_VERSION || DEFAULT_VERSION };
  const tokens = process.argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--version') args.version = tokens[++i];
    else if (t === '--help' || t === '-h') {
      console.error('Usage: node scripts/fetch-ort-ios.mjs [--version 1.24.2]');
      console.error('Prints the xcframework path on stdout for use as ORT_IOS_XCFWK_PATH.');
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

async function ensureArchive(version) {
  await mkdir(CACHE_DIR, { recursive: true });
  const archiveName = `pod-archive-onnxruntime-c-${version}.zip`;
  const archivePath = join(CACHE_DIR, archiveName);
  const archiveUrl = `https://download.onnxruntime.ai/${archiveName}`;

  if (await exists(archivePath)) {
    const sz = (await stat(archivePath)).size;
    if (sz > 1_000_000) {
      // Archive looks valid (>1 MB). Skip re-download.
      console.error(`Cached archive exists (${(sz / 1024 / 1024).toFixed(1)} MiB)`);
      return archivePath;
    }
    // Truncated download — remove and retry.
    await rm(archivePath);
  }

  console.error(`Downloading ${archiveName} (~50 MiB)...`);
  await downloadTo(archiveUrl, archivePath);
  const sz = (await stat(archivePath)).size;
  console.error(`Downloaded ${(sz / 1024 / 1024).toFixed(1)} MiB`);
  return archivePath;
}

async function extractXcframework(archivePath) {
  const destPath = join(XCFWK_DIR, 'onnxruntime.xcframework');

  // If already extracted and non-empty, skip.
  if (await exists(join(destPath, 'Info.plist'))) {
    console.error('xcframework already extracted, skipping.');
    return destPath;
  }

  // Extract to a temp dir first, then move atomically.
  const tmpExtract = join(CACHE_DIR, 'extract-ios');
  await rm(tmpExtract, { recursive: true, force: true });
  await mkdir(tmpExtract, { recursive: true });

  console.error('Extracting onnxruntime.xcframework...');
  execFileSync('unzip', ['-q', archivePath, 'onnxruntime.xcframework/*', '-d', tmpExtract], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const extracted = join(tmpExtract, 'onnxruntime.xcframework');
  if (!(await exists(extracted))) {
    throw new Error('Archive did not contain onnxruntime.xcframework/');
  }

  // Remove any stale xcframework at the destination, then move.
  await rm(destPath, { recursive: true, force: true });
  await mkdir(XCFWK_DIR, { recursive: true });

  // /tmp may be on a different filesystem, so use cp + rm instead of rename.
  execFileSync('cp', ['-R', extracted, destPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await rm(tmpExtract, { recursive: true, force: true });

  // Verify the ios-arm64 slice exists.
  const deviceLib = join(destPath, 'ios-arm64', 'onnxruntime.framework', 'onnxruntime');
  if (!(await exists(deviceLib))) {
    throw new Error(`Expected ios-arm64 static lib at ${deviceLib}`);
  }

  const sz = (await stat(deviceLib)).size;
  console.error(`  ios-arm64 static lib: ${(sz / 1024 / 1024).toFixed(1)} MiB`);

  return destPath;
}

async function ensureGitignore() {
  const gitignore = join(XCFWK_DIR, 'onnxruntime.xcframework', '.gitignore');
  // The whole xcframework dir is gitignored via a pattern in the parent.
  // But add a belt-and-suspenders .gitignore inside it too.
  const parentGitignore = join(XCFWK_DIR, '.gitignore');
  if (await exists(parentGitignore)) {
    const content = await readFile(parentGitignore, 'utf8');
    if (!content.includes('onnxruntime.xcframework')) {
      const fs = await import('node:fs/promises');
      await fs.appendFile(parentGitignore, '\n# Prebuilt ORT xcframework (fetched by scripts/fetch-ort-ios.mjs)\nonnxruntime.xcframework/\n');
      console.error(`Updated ${parentGitignore.replace(REPO_ROOT + '/', '')}`);
    }
  }
}

async function main() {
  const args = parseArgs();
  console.error(`Fetching ONNX Runtime ${args.version} xcframework for iOS`);
  const archive = await ensureArchive(args.version);
  const xcfwkPath = await extractXcframework(archive);
  await ensureGitignore();
  console.error('Done.');
  // Print the path on stdout so callers can capture it:
  //   export ORT_IOS_XCFWK_PATH=$(node scripts/fetch-ort-ios.mjs)
  console.log(xcfwkPath);
}

main().catch((e) => {
  console.error('fetch-ort-ios failed:', e);
  process.exit(1);
});
