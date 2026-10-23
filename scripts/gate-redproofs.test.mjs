import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Import dependencies are inert stubs: argument parsing must finish before any
// proof plumbing is called, even outside a Git checkout.
function invoke(args) {
  const root = mkdtempSync(path.join(tmpdir(), 'redproof-cli-'));
  try {
    mkdirSync(path.join(root, 'gate-redproofs'));
    copyFileSync(new URL('./gate-redproofs.mjs', import.meta.url), path.join(root, 'main.mjs'));
    writeFileSync(path.join(root, 'gate-redproofs/proofs.mjs'), 'export const PROOFS = [];');
    writeFileSync(path.join(root, 'gate-redproofs/seed.mjs'), 'export const seed = {};');
    writeFileSync(
      path.join(root, 'gate-redproofs/worktree.mjs'),
      'export function resolveBase() { throw new Error("proof plumbing was invoked"); }\n' +
        'export function createWorktree() {}\nexport function destroyWorktree() {}\nexport function revert() {}\n',
    );
    const result = spawnSync(process.execPath, [path.join(root, 'main.mjs'), ...args], {
      encoding: 'utf8',
    });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('redproof CLI', () => {
  it('prints help without entering the proof worktree plumbing', () => {
    const result = invoke(['--help']);
    expect(result.status).toBe(0);
    expect(result.output).toContain('Usage:');
    expect(result.output).not.toContain('proof plumbing was invoked');
  });

  it('rejects unknown arguments before entering the proof worktree plumbing', () => {
    const result = invoke(['--include-carg']);
    expect(result.status).toBe(1);
    expect(result.output).toContain('Unknown argument: --include-carg');
    expect(result.output).not.toContain('proof plumbing was invoked');
  });
});
