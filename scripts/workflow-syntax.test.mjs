import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./workflow-syntax.mjs', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (...args) =>
  spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8' });

it('validates the actual workflow scripts without running their agents', () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/[1-9][0-9]* workflow\(s\)/);
});

it('accepts top-level await/return and meta export without executing any source', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-workflow-syntax-'));
  try {
    const marker = path.join(scratch, 'executed');
    const file = path.join(scratch, 'valid.js');
    fs.writeFileSync(
      file,
      `export const meta = { name: 'example' };\nawait import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(marker)}, 'bad'));\nreturn { ok: true };\n`,
    );
    const result = run(file);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    fs.writeFileSync(file, 'export const meta = {};\nconst broken = ;\nreturn {};');
    const broken = run(file);
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toContain(file);
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

it('rejects unsupported exports and handles help before reading files', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-workflow-export-'));
  try {
    const file = path.join(scratch, 'bad-export.js');
    fs.writeFileSync(file, 'export const arbitrary = 1; return arbitrary;');
    const result = run(file);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('only export const meta');
    expect(run('--help').status).toBe(0);
    expect(run('--unknown').status).not.toBe(0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
