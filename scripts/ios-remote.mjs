#!/usr/bin/env node
// Run native iOS checks from Linux with an immutable source snapshot in a
// dedicated Mac worktree. The native OS lock spans source application, builds,
// tests and diagnostic collection. Public recipes remain the selector owner.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shQuote } from './remote-test/remote-env.mjs';
import { snapshotSource } from './ios-remote/snapshot.mjs';
import {
  bootstrapScript,
  cleanupScript,
  preflightScript,
  runScript,
} from './ios-remote/scripts.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const ALLOWED = new Set([
  'test-ios-native',
  'test-ios-native-ui',
  'test-ios-native-full',
  'test-ios-stories',
  'build-ios-native',
  'build-rust-ios',
  'lint-swift',
]);
const HELP = `just ios-remote [--host H] [--user U] [--repo PATH] <recipe> [suite/class...]
Runs current tracked and untracked source on macOS; ignored build/cache files stay local.
Recipes: ${[...ALLOWED].join(', ')}.
Defaults: FUTO_IOS_REMOTE_HOST or justins-macbook-pro; FUTO_IOS_REMOTE_USER or local user;
FUTO_IOS_REMOTE_REPO or $HOME/Developer/futo-notes/futo-notes.
Tests claim a pooled simulator for the dedicated worktree and release it after real process exit.
`;

export function parseIosRemoteArgs(args, env = process.env) {
  const options = {
    host: env.FUTO_IOS_REMOTE_HOST || 'justins-macbook-pro',
    user: env.FUTO_IOS_REMOTE_USER || userInfo().username,
    repo: env.FUTO_IOS_REMOTE_REPO || '$HOME/Developer/futo-notes/futo-notes',
  };
  let index = 0;
  for (; index < args.length && args[index].startsWith('-'); index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (
      !['--host', '--user', '--repo'].includes(flag) ||
      !args[index + 1] ||
      args[index + 1].startsWith('-')
    )
      throw new Error(`Invalid option: ${flag}`);
    options[flag.slice(2)] = args[++index];
  }
  options.recipe = args[index];
  options.recipeArgs = args.slice(index + 1);
  if (!ALLOWED.has(options.recipe)) throw new Error(`Choose a native iOS recipe. ${HELP}`);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(options.host) ||
    !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(options.user)
  )
    throw new Error('Invalid SSH host or user');
  return options;
}

function checked(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} failed (exit ${result.status ?? result.signal})`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return result;
}

export function main(args = process.argv.slice(2)) {
  let scratch;
  let remote;
  let sshArgs;
  let runStarted = false;
  try {
    const options = parseIosRemoteArgs(args);
    if (options.help) {
      console.log(HELP);
      return 0;
    }
    const pin = readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
    sshArgs = [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      `${options.user}@${options.host}`,
    ];
    scratch = mkdtempSync(path.join(tmpdir(), 'futo-ios-remote-'));
    const source = snapshotSource(ROOT, scratch);
    for (const [sourceFile, targetFile] of [
      ['scripts/ios-test-session.py', 'session.py'],
      ['scripts/ios-remote/apply-snapshot.py', 'apply.py'],
      ['scripts/ios-build-space.mjs', 'space.mjs'],
    ]) {
      writeFileSync(
        path.join(scratch, targetFile),
        execFileSync('tar', ['-xOf', path.join(scratch, 'source.tar.gz'), sourceFile]),
      );
    }
    const preflight = checked('ssh', [...sshArgs, 'bash -s'], {
      input: preflightScript({
        ...options,
        pin,
        id: source.id,
        spaceSource: readFileSync(path.join(scratch, 'space.mjs'), 'utf8'),
        minFreeGiB: process.env.FUTO_IOS_MIN_FREE_GIB || '2',
      }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    remote = JSON.parse(preflight.stdout);
    writeFileSync(path.join(scratch, 'run.sh'), runScript(source));
    const files = [
      'source.tar.gz',
      'manifest.json',
      'session.py',
      'apply.py',
      'space.mjs',
      'run.sh',
      ...(source.bundle ? ['source.bundle'] : []),
    ];
    // OpenSSH scp uses SFTP: filenames are argv values, not a remote shell program.
    checked(
      'scp',
      [
        '-B',
        '-o',
        'ConnectTimeout=8',
        ...files.map((file) => path.join(scratch, file)),
        `${options.user}@${options.host}:${remote.runDir}/`,
      ],
      { stdio: 'inherit' },
    );
    console.log(
      `[ios-remote] host=${options.host} sha=${source.sha} snapshot=${source.digest} worktree=${remote.remoteDir} recipe=${options.recipe}`,
    );
    const command = `bash -s -- ${[options.recipe, ...options.recipeArgs].map(shQuote).join(' ')}`;
    runStarted = true;
    const result = spawnSync('ssh', [...sshArgs, command], {
      input: bootstrapScript({
        ...options,
        ...source,
        ...remote,
        pin,
        minFreeGiB: process.env.FUTO_IOS_MIN_FREE_GIB || '2',
        forwarded: Object.fromEntries(
          [
            'FUTO_IOS_FFI_PROFILE',
            'FUTO_IOS_TEST_DIAGNOSTICS',
            'IOS_STORY_FILTER',
            'IOS_TEXT_INPUT',
            'IOS_STORY_NO_RESTART',
          ]
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]]),
        ),
      }),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    const code = result.status ?? 1;
    console.log(
      `[ios-remote] ${code === 0 ? 'PASS' : code === 75 ? 'BUSY' : 'FAIL'} — ${options.recipe}, exit ${code}, snapshot=${source.digest}`,
    );
    return code;
  } catch (error) {
    console.error(`ios-remote: ${error.message}`);
    return error.exitCode ?? 2;
  } finally {
    if (remote && !runStarted) {
      spawnSync('ssh', [...sshArgs, 'bash -s'], {
        input: cleanupScript(remote.runDir),
        stdio: ['pipe', 'ignore', 'inherit'],
        timeout: 15000,
      });
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
if (import.meta.main) process.exitCode = main();
