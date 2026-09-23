// Code-quality ratchet behind `just quality` and CI's test:quality-report
// (docs/architecture-gates.md). Both run this script; the pinned CI image has
// no `just`, the same reason `node scripts/audit.mjs` and test:audit share audit.mjs.
//
// One pinned `bca` (big-code-analysis) release does three things:
//
// 1. Emits a Code Climate report for GitLab's MR Code Quality widget — inline
//    annotations on the diff, sourced from `bca check`'s offender records.
// 2. Emits a human-readable markdown hotspot report (bca-report.md).
// 3. Runs the ratchet gate: `bca check` exits 2 only when a function is a NEW
//    or WORSENED offender against .bca-baseline.toml. Existing debt stays
//    invisible until its baseline row is deleted, so MR diffs stay signal.
//
// Artifacts are collected with --no-fail and validated as reports before being
// trusted (M11: a job that misses its purpose fails red — a download that
// silently yields nothing must never read as a clean scan). The binary is
// verified by sha256 on every fresh download; the CI cache key carries the
// same sha so a rotated checksum cannot serve a stale cached binary that then
// skips verification.
//
// Exit codes mirror bca's contract: 0 clean, 2 threshold violation, 1 tool
// error (including "the binary could not be obtained", reported distinctly).

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Bump together with the sha256 values, which come from the release's
// SHA256SUMS file. Schema note: the version must also support the
// .bca-baseline.toml schema version (currently 6) — the baseline refuses to
// load under an older bca.
export const BCA_VERSION = '2.2.0';
export const SHA256_BY_TARGET = {
  'aarch64-apple-darwin': '37229568ffc06041990836727e98727dc5c334ef0c54f8f92b94a48e6160de80',
  'x86_64-unknown-linux-gnu': '870a0c43b9c13f4ecac40d4a88ba7be011a0b72150d76bcc6f4906948f2adae5',
};

export function targetFor(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  throw new Error(
    `unsupported platform ${platform}-${arch} — set BCA_BIN to a prebuilt bca instead`,
  );
}

export function tarballName(version, target) {
  return `big-code-analysis-${version}-${target}.tar.gz`;
}

export function downloadUrl(version, target) {
  return `https://github.com/dekobon/big-code-analysis/releases/download/v${version}/${tarballName(version, target)}`;
}

const CACHE_DIR = path.join(ROOT, '.bca-cache');

function cachedBinaryPath() {
  return path.join(CACHE_DIR, `bca-${BCA_VERSION}`);
}

function runBca(binary, args) {
  const result = spawnSync(binary, args, { cwd: ROOT, stdio: 'inherit' });
  return result.error?.code === 'ENOENT' ? null : (result.status ?? 1);
}

function reportVersion(binary) {
  try {
    const stdout = execFileSync(binary, ['--version'], { encoding: 'utf8' });
    return stdout.trim();
  } catch {
    return null;
  }
}

// A binary that runs and reports the pinned version is trusted (its bytes were
// sha256-verified when downloaded; a failed install is never cached).
function acceptableBinary(binary) {
  return reportVersion(binary) === `bca ${BCA_VERSION}`;
}

// `sha256sum` on Linux, `shasum` on macOS — the CI image has no perl-free
// `shasum` and macOS has no `sha256sum`.
function verifySha256(file, expected) {
  const command = os.platform() === 'darwin' ? 'shasum' : 'sha256sum';
  execFileSync(command, command === 'shasum' ? ['-a', '256', '-c', '-'] : ['-c', '-'], {
    input: `${expected}  ${file}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function installFromRelease(target) {
  const sha256 = SHA256_BY_TARGET[target];
  if (!sha256)
    throw new Error(`no pinned sha256 for ${target} — add it to scripts/bca-quality.mjs`);
  const tarball = tarballName(BCA_VERSION, target);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const staged = `/tmp/${tarball}`;
  spawnSync(
    'curl',
    [
      '-fsSL',
      '--proto',
      '=https',
      '--tlsv1.2',
      '--retry',
      '3',
      '-o',
      staged,
      downloadUrl(BCA_VERSION, target),
    ],
    { stdio: 'inherit' },
  );
  verifySha256(staged, sha256);
  fs.rmSync(`${CACHE_DIR}/extract`, { recursive: true, force: true });
  fs.mkdirSync(`${CACHE_DIR}/extract`, { recursive: true });
  execFileSync('tar', ['-xzf', staged, '-C', `${CACHE_DIR}/extract`]);
  const binary = cachedBinaryPath();
  fs.copyFileSync(`${CACHE_DIR}/extract/big-code-analysis-${BCA_VERSION}-${target}/bca`, binary);
  fs.chmodSync(binary, 0o755);
  fs.rmSync(staged, { force: true });
  fs.rmSync(`${CACHE_DIR}/extract`, { recursive: true, force: true });
  return binary;
}

function ensureBca() {
  const override = process.env.BCA_BIN;
  if (override) {
    if (!acceptableBinary(override)) return null;
    return override;
  }
  const cached = cachedBinaryPath();
  if (fs.existsSync(cached) && acceptableBinary(cached)) return cached;
  const binary = installFromRelease(targetFor(os.platform(), os.arch()));
  return acceptableBinary(binary) ? binary : null;
}

// Artifacts must exist and parse as reports before they are trusted — a
// missing or empty Code Climate file would silently defang the MR widget.
function validateCodeClimateReport(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  return Array.isArray(parsed) && parsed.every((finding) => finding && typeof finding === 'object');
}

function main() {
  const binary = ensureBca();
  if (!binary) {
    // Distinct marker: with allow_failure, "found offenders" and "the tool
    // never ran" render as the same yellow badge (M11); /ci-doctor greps for
    // this line. Any cached binary that failed the version check is deleted
    // so it cannot satisfy the cache hit forever.
    const cached = cachedBinaryPath();
    if (fs.existsSync(cached) && !process.env.BCA_BIN) fs.rmSync(cached);
    console.error(
      `\nBCA-DID-NOT-RUN: bca ${BCA_VERSION} could not be obtained, so code quality was not scanned.`,
    );
    process.exit(1);
  }

  const codeClimate = path.join(ROOT, 'gl-code-quality-report.json');
  const status = runBca(binary, [
    'check',
    '--report-format',
    'code-climate',
    '--output',
    codeClimate,
    '--no-fail',
  ]);
  if (status === null || !validateCodeClimateReport(codeClimate)) {
    console.error('\nBCA-DID-NOT-RUN: the Code Climate report is missing or malformed.');
    process.exit(1);
  }

  const markdown = path.join(ROOT, 'bca-report.md');
  const reportStatus = runBca(binary, [
    'report',
    '-O',
    'markdown',
    '--top',
    '20',
    '--output',
    markdown,
  ]);
  if (reportStatus === null || !fs.existsSync(markdown) || fs.statSync(markdown).size === 0) {
    console.error('\nBCA-DID-NOT-RUN: the markdown hotspot report is missing or empty.');
    process.exit(1);
  }

  // The gate runs last so both artifacts publish even when it fails (CI
  // artifacts are `when: always`). Exit codes: 0 clean, 2 new/worsened
  // offender, anything else is a tool error and must not read as a pass.
  const gate = runBca(binary, ['check']);
  if (gate === null) {
    console.error('\nBCA-DID-NOT-RUN: bca check could not run.');
    process.exit(1);
  }
  if (gate === 0 || gate === 2) process.exit(gate);
  process.exit(1);
}

// Run only as a script, not under `import` in the unit test.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main();
