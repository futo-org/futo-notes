import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pc_4bc25890e000: a pool device keeps the debug app's vault across claims, so
// qa.mjs wipes it when the device changes hands — and must not when the same
// worktree claims again mid-session, or it would erase that session's state.
describe('claimPoolName', () => {
  let home;
  let root;
  let pool;

  const ownerFile = (name) => path.join(home, '.futo-notes-qa', 'devices', `android-${name}.json`);
  const newRoot = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wt-')));
    execFileSync('git', ['init', '-q', dir]);
    return dir;
  };

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-home-'));
    vi.stubEnv('HOME', home);
    vi.resetModules();
    pool = await import('./pool.mjs');
    root = newRoot();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is fresh for a free device and not for one this worktree holds', () => {
    const first = pool.claimPoolName('android', root);
    expect(first.fresh).toBe(true);
    pool.markWiped('android', first.name);
    expect(pool.claimPoolName('android', root)).toEqual({ name: first.name, fresh: false });
  });

  it('is fresh when taken from a worktree that no longer exists', () => {
    const { name } = pool.claimPoolName('android', root);
    const gone = path.join(home, 'deleted-worktree');
    fs.writeFileSync(ownerFile(name), JSON.stringify({ worktree: gone }));
    expect(pool.claimPoolName('android', root)).toEqual({ name, fresh: true });
    expect(JSON.parse(fs.readFileSync(ownerFile(name), 'utf8')).worktree).toBe(root);
  });

  // MR !446 QA: the claim is written before the emulator boots, and a boot that
  // dies (die exits the process) kept it, so the retry saw a 'held' device and
  // skipped the wipe of the previous worktree's install.
  it('stays fresh until the handover wipe completes', () => {
    const { name } = pool.claimPoolName('android', root);
    expect(pool.claimPoolName('android', root)).toEqual({ name, fresh: true });
    pool.markWiped('android', name);
    expect(pool.claimPoolName('android', root)).toEqual({ name, fresh: false });
  });
});
