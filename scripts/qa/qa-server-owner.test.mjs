import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireServerStartLock,
  assertServerOwner,
  claimServerOwner,
  releaseServerOwner,
} from './qa-server-owner.mjs';

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-server-owner-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('QA sync server ownership', () => {
  it('atomically grants a slot to one worktree and refuses a colliding peer', () => {
    const dir = tempDir();
    expect(claimServerOwner(dir, '/worktrees/one')).toBe(true);
    expect(() => claimServerOwner(dir, '/worktrees/two')).toThrow(/another worktree/);
    expect(assertServerOwner(dir, '/worktrees/one').worktree).toBe('/worktrees/one');
  });

  it('refuses to stop or drop a server whose owner metadata is missing or malformed', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'owner.json'), '{');
    expect(() => assertServerOwner(dir, '/worktrees/one')).toThrow(/ownership is unknown/);
  });

  it('serializes simultaneous starts, including starts by the same worktree', () => {
    const dir = tempDir();
    const release = acquireServerStartLock(dir, '/worktrees/one');
    expect(() => acquireServerStartLock(dir, '/worktrees/one')).toThrow(
      /another sync server start/,
    );
    release();
    expect(() => acquireServerStartLock(dir, '/worktrees/one')).not.toThrow();
  });

  it('removes the owner record only for its recorded worktree', () => {
    const dir = tempDir();
    claimServerOwner(dir, '/worktrees/one');
    expect(() => releaseServerOwner(dir, '/worktrees/two')).toThrow(/another worktree/);
    releaseServerOwner(dir, '/worktrees/one');
  });
});
