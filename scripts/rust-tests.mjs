#!/usr/bin/env node
/** Canonical Rust test routes: `just test-sync` and `just test-rust-full`.
 * Sync tests run individually in nextest so a deadlock produces a named TIMEOUT
 * after two minutes instead of parking the whole libtest process indefinitely.
 * Cargo still owns doctests (nextest cannot run them). Other workspace crates
 * retain their existing cargo test coverage. Server-only tests remain ignored
 * here; `just test-sync-integration` explicitly selects them against real servers.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(fs.readFileSync(path.join(root, 'scripts/cargo-nextest-pin.json'), 'utf8'));

export function ensureNextest(
  repoRoot = root,
  exec = spawnSync,
  { platform = process.platform, env = process.env } = {},
) {
  const paths = platform === 'win32' ? path.win32 : path;
  const installDir = paths.resolve(
    repoRoot,
    env.NEXTEST_INSTALL_DIR ??
      paths.join(env.CARGO_HOME ?? paths.join(os.homedir(), '.cargo'), 'bin'),
  );
  const binary = paths.join(
    installDir,
    platform === 'win32' ? 'cargo-nextest.exe' : 'cargo-nextest',
  );
  const current = exec(binary, ['--version'], { encoding: 'utf8' });
  if (current.status === 0 && current.stdout.split(/\s+/)[1] === pin.version) return binary;
  if (platform === 'win32')
    throw new Error(
      `pinned Windows nextest ${pin.version} is required at ${binary}; install the exact version from https://nexte.st/docs/installation/pre-built-binaries/ or set NEXTEST_INSTALL_DIR`,
    );
  const setup = exec('sh', [path.join(repoRoot, 'ci/install-nextest.sh')], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...env, NEXTEST_INSTALL_DIR: installDir },
  });
  if (setup.status !== 0)
    throw new Error('nextest setup failed; install the pinned binary before running Rust tests');
  const installed = exec(binary, ['--version'], { encoding: 'utf8' });
  if (installed.status !== 0 || installed.stdout.split(/\s+/)[1] !== pin.version)
    throw new Error(`pinned nextest ${pin.version} is not executable at ${binary}`);
  return binary;
}

export function syncNextestArgs({ integration = false, extraTestArgs = [] } = {}) {
  return [
    'nextest',
    'run',
    '-p',
    'futo-notes-sync',
    '--profile=sync',
    '--no-tests=fail',
    '--no-fail-fast',
    ...(integration
      ? [
          '--test',
          'server_integration',
          '--test',
          'sse_live',
          '--run-ignored=only',
          '--test-threads=1',
        ]
      : []),
    ...(extraTestArgs.length ? ['--', ...extraTestArgs] : []),
  ];
}

export function runRustTests({
  scope = 'sync',
  root: repoRoot = root,
  nextest = ensureNextest(repoRoot),
  exec = spawnSync,
} = {}) {
  const commands = [
    ...(scope === 'workspace'
      ? [['cargo', ['test', '--workspace', '--exclude', 'futo-notes-sync']]]
      : []),
    [nextest, syncNextestArgs()],
    ['cargo', ['test', '-p', 'futo-notes-sync', '--doc']],
  ];
  for (const [command, args] of commands) {
    console.log(`==> ${command} ${args.join(' ')}`);
    const result = exec(command, args, { cwd: repoRoot, stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length > 1 || (args[0] && !['sync', 'workspace'].includes(args[0])))
      throw new Error('usage: just test-sync | just test-rust-full');
    process.exitCode = runRustTests({ scope: args[0] ?? 'sync' });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
