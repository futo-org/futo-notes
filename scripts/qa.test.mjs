import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { slotOf } from './lib/slot.mjs';

const QA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'qa.mjs');

// pc_c4b48ce7a32e: two QA agents (Android + iOS) sharing one worktree — the
// Android agent's cleanup released, and could shut down, the iOS agent's
// simulator, because `release` took every claim the worktree held. These run
// qa.mjs for real against a throwaway HOME and git repo; without --shutdown
// release only deletes owner files, so no device is touched.
describe('qa.mjs release', () => {
  let home;
  let root;

  const ownerFile = (platform) =>
    path.join(home, '.futo-notes-qa', 'devices', `${platform}-futo-qa-0.json`);

  function release(...args) {
    return spawnSync(process.execPath, [QA, 'release', ...args], {
      cwd: root,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-home-'));
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wt-')));
    execFileSync('git', ['init', '-q', root]);
    fs.mkdirSync(path.dirname(ownerFile('ios')), { recursive: true });
    for (const platform of ['ios', 'android']) {
      fs.writeFileSync(ownerFile(platform), JSON.stringify({ worktree: root }));
    }
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('releases only the named platform', () => {
    const result = release('android');
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(ownerFile('android'))).toBe(false);
    expect(fs.existsSync(ownerFile('ios'))).toBe(true);
  });

  it('releases every platform when none is named', () => {
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(ownerFile('android'))).toBe(false);
    expect(fs.existsSync(ownerFile('ios'))).toBe(false);
  });

  // pc_511cd186988a: an Android leg named its platform, held the worktree's
  // last device claim, and its release stopped the sync server the desktop
  // leg (which claims no device) was still using.
  describe('the slot sync server', () => {
    const serverOwner = () =>
      path.join(home, '.futo-notes-qa', 'server', `s${slotOf(root)}`, 'owner.json');

    beforeEach(() => {
      const dir = path.dirname(serverOwner());
      fs.mkdirSync(dir, { recursive: true });
      for (const file of ['owner.json', 'meta.json']) {
        fs.writeFileSync(path.join(dir, file), JSON.stringify({ worktree: root }));
      }
      fs.rmSync(ownerFile('ios'));
    });

    it('stays up when the named platform held the last claim', () => {
      const result = release('android');
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(ownerFile('android'))).toBe(false);
      expect(fs.existsSync(serverOwner())).toBe(true);
    });

    it('stops when no platform is named', () => {
      const result = release();
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(serverOwner())).toBe(false);
    });
  });

  it('rejects an unknown platform instead of releasing everything', () => {
    const result = release('windows');
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(ownerFile('android'))).toBe(true);
    expect(fs.existsSync(ownerFile('ios'))).toBe(true);
  });
});

// Argument mistakes must never claim, boot, or wipe a device.
describe('qa.mjs claim arguments', () => {
  let scratch;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-args-'));
    execFileSync('git', ['init', '-q', scratch]);
    fs.mkdirSync(path.join(scratch, 'bin'));
    for (const tool of ['adb', 'xcrun', 'open']) {
      fs.writeFileSync(path.join(scratch, 'bin', tool), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    }
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  function claim(...args) {
    return spawnSync(process.execPath, [QA, 'claim', ...args], {
      cwd: scratch,
      env: {
        ...process.env,
        HOME: scratch,
        ANDROID_HOME: path.join(scratch, 'absent-sdk'),
        PATH: path.join(scratch, 'bin') + path.delimiter + process.env.PATH,
      },
      encoding: 'utf8',
    });
  }

  it('prints help without creating a claim or invoking a device tool', () => {
    const result = claim('--help');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('usage:');
    expect(fs.existsSync(path.join(scratch, '.futo-notes-qa'))).toBe(false);
  });

  it.each([['--typo'], ['android', 'ios'], ['android', '--typo']])(
    'rejects invalid arguments %j before creating a claim',
    (...args) => {
      const result = claim(...args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unknown claim option|at most one platform/);
      expect(fs.existsSync(path.join(scratch, '.futo-notes-qa'))).toBe(false);
    },
  );
});
