import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ALLOWLIST, MAX_BYTES } from './check-file-tokens.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'check-file-tokens.mjs');

let repo;

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function stage(name, content) {
  mkdirSync(dirname(join(repo, name)), { recursive: true });
  writeFileSync(join(repo, name), content);
  git('add', name);
}

function stageAllowlist(...paths) {
  const entries = paths.map((path) => ({ path, reason: 'large by design' }));
  stage(ALLOWLIST, JSON.stringify({ entries }));
}

function runGate() {
  return spawnSync(process.execPath, [GATE], { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'futo-file-tokens-'));
  git('init', '-q');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('file token gate', () => {
  it('fails on a staged file over the limit and explains how to split it', () => {
    stage('big.ts', 'x'.repeat(MAX_BYTES + 1));

    const result = runGate();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('big.ts  ~5,001 tokens');
    expect(result.stderr).toContain('How to split:');
  });

  it('passes a file exactly at the limit', () => {
    stage('ok.ts', 'x'.repeat(MAX_BYTES));

    expect(runGate().status).toBe(0);
  });

  it('measures the staged blob, not the working tree', () => {
    stage('small.ts', 'x');
    writeFileSync(join(repo, 'small.ts'), 'x'.repeat(MAX_BYTES + 1));

    expect(runGate().status).toBe(0);
  });

  it('skips binary content without an allowlist entry', () => {
    stage('font.bin', Buffer.concat([Buffer.from([0]), Buffer.alloc(MAX_BYTES + 1, 1)]));
    stage('env.hdr', Buffer.alloc(MAX_BYTES + 1, 0xff));

    expect(runGate().status).toBe(0);
  });

  it('allows an oversized file only when the allowlist names its exact path', () => {
    stage('languages/en.json', 'x'.repeat(MAX_BYTES + 1));
    stage('languages/fr.json', 'x'.repeat(MAX_BYTES + 1));
    stageAllowlist('languages/en.json');

    const result = runGate();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('languages/fr.json');
    expect(result.stderr).not.toContain('languages/en.json  ~');
  });

  it('does not exempt a file for carrying a generated-file header', () => {
    stage('Spec.kt', `// GENERATED FILE — DO NOT EDIT.\n${'x'.repeat(MAX_BYTES)}`);

    expect(runGate().status).toBe(1);
  });

  it('fails on an allowlist entry whose file is back under the limit or gone', () => {
    stage('small.json', 'x');
    stageAllowlist('small.json', 'deleted.json');

    const result = runGate();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no longer apply');
    expect(result.stderr).toContain('small.json');
    expect(result.stderr).toContain('deleted.json');
  });

  it('rejects an allowlist entry without a reason', () => {
    stage('big.json', 'x'.repeat(MAX_BYTES + 1));
    stage(ALLOWLIST, JSON.stringify({ entries: [{ path: 'big.json' }] }));

    const result = runGate();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('needs a "path" and a "reason"');
  });
});
