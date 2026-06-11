#!/usr/bin/env node
// Stage the SPLADE doc encoder ONNX + WordPiece tokenizer for FUTO Notes
// learned-sparse search.
//
// Source: huggingface.co/opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill
//   Apache 2.0, ~67M-param DistilBERT-based SPLADE doc encoder. We build the
//   ONNX export from the canonical safetensors ourselves via
//   `scripts/build-splade-onnx.py` (uv-driven) — no community mirror in the
//   critical path.
//
// This script is the orchestrator that justfile recipes call. It:
//   1. Runs the Python build (cached by upstream revision; cheap if cached)
//   2. Copies the cached artifacts into per-platform `gen/{linux,android,apple}/`
//   3. Mirrors into target/{debug,release}/ so cargo-run resolves the model
//
// Usage:
//   node scripts/fetch-splade-model.mjs                     # all platforms
//   node scripts/fetch-splade-model.mjs --target linux      # specific platform
//   node scripts/fetch-splade-model.mjs --target android
//   node scripts/fetch-splade-model.mjs --target apple
//
// The staged files are NOT committed to git. Run this before
// building/installing the Tauri app on any platform.

import { copyFile, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const BUILD_SCRIPT = join(SCRIPT_DIR, 'build-splade-onnx.py');
const CACHE_DIR = join(tmpdir(), 'futo-notes-splade-cache');
const CACHED_MODEL = join(CACHE_DIR, 'splade-model.onnx');
const CACHED_MODEL_FP16 = join(CACHE_DIR, 'splade-model-fp16.onnx');
const CACHED_TOKENIZER = join(CACHE_DIR, 'splade-tokenizer.json');

// Where each platform expects the files. Tauri bundling reads from these
// per-platform paths.
const PLATFORM_DIRS = {
  linux: join(REPO_ROOT, 'apps/tauri/src-tauri/gen/linux'),
  // Android Gradle auto-bundles everything under assets/ into the APK root.
  android: join(REPO_ROOT, 'apps/tauri/src-tauri/gen/android/app/src/main/assets'),
  // iOS project.yml declares `path: assets, buildPhase: resources, type: folder`
  // (gen/apple/project.yml line 36-38), so files placed under gen/apple/assets/
  // are copied into the .ipa bundle.
  apple: join(REPO_ROOT, 'apps/tauri/src-tauri/gen/apple/assets'),
  // Windows: `tauri.windows.conf.json` declares a Windows-only
  // `bundle.resources` map that copies these files into the install dir
  // next to the .exe. We use an overlay file rather than top-level
  // `bundle.resources` because top-level resources also affect the iOS
  // pipeline (where Tauri's CLI used to truncate them in place — see
  // docs/splade-search.md "Tauri bundle.resources truncates source files
  // on iOS").
  windows: join(REPO_ROOT, 'apps/tauri/src-tauri/gen/windows'),
};

// Also mirror into target/{debug,release}/ so cargo-run-style invocations can
// find the model via the sibling-of-exe probe in core::splade_search.
const TARGET_DIRS = [
  join(REPO_ROOT, 'target/debug'),
  join(REPO_ROOT, 'target/release'),
];

function parseArgs() {
  const args = { target: 'all', force: false };
  const tokens = process.argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--target') args.target = tokens[++i];
    else if (t === '--force') args.force = true;
    else if (t === '--help' || t === '-h') {
      console.log('Usage: node scripts/fetch-splade-model.mjs [--target linux|android|apple|windows|all] [--force]');
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
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runBuildScript(force) {
  const buildArgs = [BUILD_SCRIPT];
  if (force) buildArgs.push('--force');
  return new Promise((resolveSpawn, rejectSpawn) => {
    const proc = spawn('uv', ['run', '--quiet', ...buildArgs], {
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('exit', (code) => {
      if (code === 0) resolveSpawn();
      else rejectSpawn(new Error(`build-splade-onnx.py exited with code ${code}`));
    });
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        rejectSpawn(new Error(
          'uv not found on PATH. Install uv (https://docs.astral.sh/uv/) — ' +
          'the build script needs Python + transformers + optimum to export the ONNX.',
        ));
      } else {
        rejectSpawn(err);
      }
    });
  });
}

async function placeForPlatform(target) {
  const dir = PLATFORM_DIRS[target];
  if (!dir) throw new Error(`Unknown target: ${target}`);
  await mkdir(dir, { recursive: true });
  await copyFile(CACHED_MODEL, join(dir, 'splade-model.onnx'));
  await copyFile(CACHED_TOKENIZER, join(dir, 'splade-tokenizer.json'));
  // Apple platforms (macOS + iOS) also get the fp16 variant. CoreML EP
  // doesn't accept the int8-quantized graph; fp16 with seq=128 fixed
  // shape runs natively on ANE/GPU. The encoder picks fp16 over int8 at
  // load time when the feature + env are set.
  if (target === 'apple') {
    await copyFile(CACHED_MODEL_FP16, join(dir, 'splade-model-fp16.onnx'));
    console.log(`  ${target}: ${dir.replace(REPO_ROOT + '/', '')}/{splade-model.onnx, splade-model-fp16.onnx, splade-tokenizer.json}`);
  } else {
    console.log(`  ${target}: ${dir.replace(REPO_ROOT + '/', '')}/{splade-model.onnx, splade-tokenizer.json}`);
  }
}

async function placeForTargetDirs() {
  for (const dir of TARGET_DIRS) {
    if (await exists(dir)) {
      await copyFile(CACHED_MODEL, join(dir, 'splade-model.onnx'));
      await copyFile(CACHED_TOKENIZER, join(dir, 'splade-tokenizer.json'));
      console.log(`  cargo: ${dir.replace(REPO_ROOT + '/', '')}/{splade-model.onnx, splade-tokenizer.json}`);
    }
  }
}

async function ensureGitignore(dir) {
  const gitignore = join(dir, '.gitignore');
  let body = '';
  if (await exists(gitignore)) {
    body = await readFile(gitignore, 'utf8');
  }
  let changed = false;
  for (const name of ['splade-model.onnx', 'splade-model-fp16.onnx', 'splade-tokenizer.json']) {
    if (!body.split('\n').includes(name)) {
      if (body && !body.endsWith('\n')) body += '\n';
      body += `${name}\n`;
      changed = true;
    }
  }
  if (changed) {
    await mkdir(dir, { recursive: true });
    await writeFile(gitignore, body);
  }
}

async function main() {
  const { target, force } = parseArgs();
  // SPLADE is on hold (docs/spec: Android Tauri ships BM25-only; the
  // model_file_missing state is a recorded gap). A failed model build must
  // not kill the platform build recipes that call this script — warn, skip
  // staging, and let the app fall back to BM25.
  try {
    await runBuildScript(force);
  } catch (e) {
    console.warn(`fetch-splade-model: model build unavailable (${e.message})`);
    console.warn('Skipping SPLADE staging — search runs BM25-only on this build.');
    return;
  }

  if (!(await exists(CACHED_MODEL)) || !(await exists(CACHED_TOKENIZER))) {
    throw new Error(`Build script claimed success but artifacts missing in ${CACHE_DIR}`);
  }

  const targets = target === 'all' ? Object.keys(PLATFORM_DIRS) : [target];
  for (const t of targets) {
    await placeForPlatform(t);
    await ensureGitignore(PLATFORM_DIRS[t]);
  }
  await placeForTargetDirs();

  console.log('Done.');
}

main().catch((e) => {
  console.error('fetch-splade-model failed:', e.message);
  process.exit(1);
});
