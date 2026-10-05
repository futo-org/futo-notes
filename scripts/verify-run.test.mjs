import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./verify-run.mjs', import.meta.url));
const scratchpads = [];
afterEach(() => {
  for (const dir of scratchpads.splice(0)) fs.rmSync(dir, { recursive: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-run-'));
  scratchpads.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  fs.writeFileSync(path.join(root, '.gitignore'), 'verification-runs/\n');
  fs.writeFileSync(path.join(root, 'justfile'), 'probe code:\n  node probe.mjs {{code}}\n');
  fs.writeFileSync(
    path.join(root, 'probe.mjs'),
    `import fs from 'node:fs';
fs.writeFileSync(process.env.FUTO_VERIFICATION_DIR + '/result.txt', 'evidence ' + process.argv[2]);
console.log('recipe stdout'); console.error('recipe stderr'); process.exit(Number(process.argv[2]));\n`,
  );
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  return root;
}

it('retains separate failed and successful runs with source identity, logs and artifacts', () => {
  const root = fixture();
  for (const code of [7, 0]) {
    const result = spawnSync(process.execPath, [script, 'probe', String(code)], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(code);
  }
  const dirs = fs.readdirSync(path.join(root, 'verification-runs'));
  expect(dirs).toHaveLength(2);
  const runs = dirs.map((dir) => {
    const location = path.join(root, 'verification-runs', dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(location, 'manifest.json'), 'utf8'));
    expect(manifest.sourceBefore.fingerprint).toBe(manifest.sourceAfter.fingerprint);
    expect(manifest.sourceBefore.head).toMatch(/^[a-f0-9]{40}$/);
    expect(fs.readFileSync(path.join(location, 'command.log'), 'utf8')).toContain('recipe stderr');
    expect(fs.readFileSync(path.join(location, 'report.md'), 'utf8')).toContain('result.txt');
    expect(manifest.artifacts).toContain('result.txt');
    return manifest.status;
  });
  expect(runs.sort()).toEqual(['FAIL', 'PASS']);
});

it('marks a successful command VOID when dirty source content changes during execution', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'before');
  fs.writeFileSync(
    path.join(root, 'probe.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync('untracked.txt', 'after');`,
  );
  const result = spawnSync(process.execPath, [script, 'probe', '0'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(76);
  const dir = fs.readdirSync(path.join(root, 'verification-runs'))[0];
  const report = JSON.parse(
    fs.readFileSync(path.join(root, 'verification-runs', dir, 'manifest.json'), 'utf8'),
  );
  expect(report.exitCode).toBe(0);
  expect(report.status).toBe('VOID');
  expect(report.sourceBefore.fingerprint).not.toBe(report.sourceAfter.fingerprint);
});
