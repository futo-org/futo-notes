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

  it.each(['token', 'inode'])(
    'refuses a replaced iOS allocation lock with different %s identity without removing it',
    (replacement) => {
      const file = path.join(home, '.futo-notes-qa', 'ios-allocation.lock');
      const foreign = JSON.stringify({ worktree: '/foreign', pid: process.pid, token: 'foreign' });
      expect(() =>
        pool.claimPoolName('ios', root, {
          sim: 'futo-qa-1',
          inspectSimulators: () => {
            if (replacement === 'inode') fs.unlinkSync(file);
            fs.writeFileSync(file, foreign);
            return [{ name: 'futo-qa-1', udid: 'one', isAvailable: true }];
          },
        }),
      ).toThrow('lock identity changed');
      expect(fs.readFileSync(file, 'utf8')).toBe(foreign);
      expect(fs.existsSync(path.join(home, '.futo-notes-qa/devices'))).toBe(false);
    },
  );

  // `qa-claim android --extra`: shard targets for `just test-android-ui --shard`.
  it('adds extra Android claims beside the first, up to the shared-pool limit', () => {
    expect(() => pool.claimExtraAndroid(root)).toThrow(/claim this worktree's emulator first/);
    const first = pool.claimPoolName('android', root);
    pool.markWiped('android', first.name);
    const names = [first.name];
    for (let i = 1; i < pool.MAX_ANDROID_CLAIMS; i++) {
      const extra = pool.claimExtraAndroid(root);
      expect(extra.fresh).toBe(true);
      expect(names).not.toContain(extra.name);
      expect(JSON.parse(fs.readFileSync(ownerFile(extra.name), 'utf8')).extra).toBe(true);
      pool.markWiped('android', extra.name);
      names.push(extra.name);
    }
    expect(() => pool.claimExtraAndroid(root)).toThrow(/limit/);
    // A plain claim still answers with the worktree's own emulator, never an extra.
    expect(pool.claimPoolName('android', root)).toEqual({ name: first.name, fresh: false });
  });

  it('keeps Android allocation independent of a foreign iOS lock', () => {
    const file = path.join(home, '.futo-notes-qa', 'ios-allocation.lock');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'OTHER ALLOCATOR');
    const result = pool.claimPoolName('android', root);
    expect(result.fresh).toBe(true);
    expect(JSON.parse(fs.readFileSync(ownerFile(result.name), 'utf8')).worktree).toBe(root);
    expect(fs.readFileSync(file, 'utf8')).toBe('OTHER ALLOCATOR');
  });

  it('shares the iOS allocation critical section with the default allocator', () => {
    let refusal;
    const result = pool.claimPoolName('ios', root, {
      sim: 'futo-qa-1',
      inspectSimulators: () => {
        try {
          pool.claimPoolName('ios', root);
        } catch (error) {
          refusal = error;
        }
        expect(fs.existsSync(path.join(home, '.futo-notes-qa/devices'))).toBe(false);
        return [{ name: 'futo-qa-1', udid: 'one', isAvailable: true }];
      },
    });
    expect(refusal?.message).toContain('another iOS allocation');
    expect(result).toEqual({ name: 'futo-qa-1', fresh: true });
    expect(fs.existsSync(path.join(home, '.futo-notes-qa/ios-allocation.lock'))).toBe(false);
  });
});
