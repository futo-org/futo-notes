#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help') {
  console.log('Usage: just verify-run <recipe> [recipe arguments...]');
  process.exit(args.length ? 0 : 2);
}
if (!/^[A-Za-z][\w-]*$/.test(args[0]) || args[0] === 'verify-run') {
  console.error('verify-run: expected a recipe name (not an option or verify-run itself)');
  process.exit(2);
}

function git(root, ...argv) {
  return execFileSync('git', argv, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function sourceIdentity(root) {
  const head = git(root, 'rev-parse', 'HEAD').trim();
  const hash = createHash('sha256').update(head);
  const files = [
    ...new Set(
      git(
        root,
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '.',
        ':(exclude)keys/**',
      )
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  for (const file of files) {
    const absolute = path.join(root, file);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    const digest = createHash('sha256');
    if (stat?.isSymbolicLink()) digest.update(fs.readlinkSync(absolute));
    else if (stat?.isFile()) digest.update(fs.readFileSync(absolute));
    else if (stat?.isDirectory()) throw new Error(`Cannot fingerprint nested repository: ${file}`);
    hash.update(JSON.stringify([file, stat?.mode ?? 'deleted', digest.digest('hex')]));
  }
  return {
    head,
    fingerprint: hash.digest('hex'),
    dirty: Boolean(git(root, 'status', '--porcelain').trim()),
    scope: 'HEAD plus tracked/untracked nonignored file contents; keys excluded',
    files: files.length,
  };
}

function artifactsIn(dir, prefix = '') {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink() || ['manifest.json', 'report.md'].includes(name)) return [];
      return entry.isDirectory() ? artifactsIn(path.join(dir, entry.name), name + '/') : [name];
    })
    .sort();
}

async function main() {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  // Keep evidence OUTSIDE Playwright's test-results: even an ordinary subsequent
  // Playwright run clears that directory. Refuse unignored output before writing it.
  execFileSync('git', ['check-ignore', '-q', 'verification-runs/probe'], { cwd: root });
  const parent = path.join(root, 'verification-runs');
  if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error('verification-runs must not be a symlink');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(parent, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    root,
    command: ['just', ...args],
    host: os.hostname(),
    platform: process.platform,
    node: process.version,
    startedAt: new Date().toISOString(),
    status: 'RUNNING',
    sourceBefore: sourceIdentity(root),
    coverage:
      'Recipe exit status only. App/engine/device claims require artifacts from the harness.',
  };
  const save = () =>
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  save();
  console.log(`Evidence: ${dir}`);
  const log = fs.openSync(path.join(dir, 'command.log'), 'wx');
  const child = spawn('just', args, {
    cwd: root,
    env: { ...process.env, FUTO_VERIFICATION_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const forward = (stream) => (chunk) => {
    fs.writeSync(log, chunk);
    stream.write(chunk);
  };
  child.stdout.on('data', forward(process.stdout));
  child.stderr.on('data', forward(process.stderr));
  const onSignal = (signal) => {
    if (child.pid && child.exitCode === null) {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal); // Only the process group created above.
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: 1, error: error.message }));
    child.once('close', (code, signal) => resolve({ code: code ?? 130, signal }));
  });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  fs.closeSync(log);
  manifest.exitCode = result.code;
  manifest.signal = result.signal ?? null;
  if (result.error) manifest.error = result.error;
  manifest.finishedAt = new Date().toISOString();
  manifest.status = result.code === 0 ? 'PASS' : 'FAIL';
  try {
    manifest.sourceAfter = sourceIdentity(root);
    if (manifest.sourceBefore.fingerprint !== manifest.sourceAfter.fingerprint)
      manifest.status = 'VOID';
  } catch (error) {
    manifest.status = 'VOID';
    manifest.error = error.message;
  }
  manifest.artifacts = artifactsIn(dir);
  save();
  fs.writeFileSync(
    path.join(dir, 'report.md'),
    `# ${manifest.status}: ${args[0]}\n\n` +
      `Command argv: \`${JSON.stringify(manifest.command)}\`\n\n` +
      `Host: ${manifest.host} (${manifest.platform})\n\nSource: ${manifest.sourceBefore.head}; fingerprint ${manifest.sourceBefore.fingerprint}\n\n` +
      `${manifest.coverage}\n\n[Manifest](manifest.json)\n\n` +
      manifest.artifacts
        .map((file) => `- [${file}](${file.split('/').map(encodeURIComponent).join('/')})`)
        .join('\n') +
      '\n',
  );
  console.log(`${manifest.status}: ${path.join(dir, 'report.md')}`);
  process.exitCode = manifest.status === 'VOID' ? 76 : result.code;
}

main().catch((error) => {
  console.error(`verify-run: ${error.message}`);
  process.exitCode = 1;
});
