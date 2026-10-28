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

  it.each([[], ['all'], ['android']])(
    'requires an explicit ios target for erase %j',
    (...target) => {
      const result = claim(...target, '--erase');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--erase requires the explicit ios target');
      expect(fs.existsSync(path.join(scratch, '.futo-notes-qa'))).toBe(false);
    },
  );

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

// Legacy-WebView fixtures must arbitrate ownership too, without rewriting
// their pinned emulator config, snapshots, app data, or WebView installation.
describe('named legacy Android QA claims', () => {
  let scratch;
  let root;
  let peer;
  let env;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-legacy-'));
    root = fs.realpathSync(scratch) + '/root';
    peer = fs.realpathSync(scratch) + '/peer';
    for (const dir of [root, peer]) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', dir]);
    }
    const bin = path.join(scratch, 'bin');
    const sdk = path.join(scratch, 'sdk');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(sdk, 'emulator'), { recursive: true });
    fs.writeFileSync(path.join(sdk, 'emulator/emulator'), '#!/bin/sh\necho futo-api28\n', {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(bin, 'adb'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$QA_TOOL_LOG"
case "$*" in
  devices) printf 'List of devices attached\\nemulator-8888\\tdevice\\n' ;;
  '-s emulator-8888 emu avd name') printf 'futo-api28\\nOK\\n' ;;
  *) echo 'unexpected device command' >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const avdmanager = path.join(sdk, 'cmdline-tools/latest/bin/avdmanager');
    fs.mkdirSync(path.dirname(avdmanager), { recursive: true });
    fs.writeFileSync(
      avdmanager,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$QA_TOOL_LOG"
exit 1
`,
      { mode: 0o755 },
    );
    env = {
      ...process.env,
      HOME: scratch,
      ANDROID_HOME: sdk,
      PATH: bin + path.delimiter + process.env.PATH,
      QA_TOOL_LOG: path.join(scratch, 'tools.log'),
    };
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const run = (cwd, ...args) =>
    spawnSync(process.execPath, [QA, ...args], { cwd, env, encoding: 'utf8' });

  it('claims an existing legacy fixture and lists it without wiping or reconfiguring it', () => {
    const result = run(root, 'claim', 'android', '--avd', 'futo-api28');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('export ANDROID_SERIAL=emulator-8888');
    expect(result.stdout).toContain('export ANDROID_AVD_NAME=futo-api28');
    const owner = JSON.parse(
      fs.readFileSync(path.join(scratch, '.futo-notes-qa/devices/android-futo-api28.json'), 'utf8'),
    );
    expect(owner.worktree).toBe(root);
    expect(owner.wipePending).toBeUndefined();
    const status = run(root, 'status');
    expect(status.stderr).toContain(`futo-api28: booted emulator-8888 — ${root}`);
    const commands = fs.readFileSync(env.QA_TOOL_LOG, 'utf8');
    expect(commands).not.toMatch(/pm clear|uninstall|rm -rf|emu kill/);
    expect(run(peer, 'claim', 'android', '--avd', 'futo-api28').status).not.toBe(0);
    const release = run(root, 'release', 'android');
    expect(release.status, release.stderr).toBe(0);
    expect(
      fs.existsSync(path.join(scratch, '.futo-notes-qa/devices/android-futo-api28.json')),
    ).toBe(false);
  });
  it('gc releases a stale legacy owner without stopping or deleting the fixture', () => {
    expect(run(root, 'claim', 'android', '--avd', 'futo-api28').status).toBe(0);
    const ownerFile = path.join(scratch, '.futo-notes-qa/devices/android-futo-api28.json');
    fs.writeFileSync(ownerFile, JSON.stringify({ worktree: path.join(scratch, 'deleted-root') }));
    const result = run(root, 'gc');
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(ownerFile)).toBe(false);
    expect(fs.readFileSync(env.QA_TOOL_LOG, 'utf8')).not.toMatch(/emu kill|delete avd/);
  });

  it.each([
    ['android', '--avd'],
    ['android', '--avd', 'personal-phone'],
    ['ios', '--avd', 'futo-api28'],
  ])('rejects unsupported named claims %j before writing ownership', (...args) => {
    expect(run(root, 'claim', ...args).status).not.toBe(0);
    expect(fs.existsSync(path.join(scratch, '.futo-notes-qa/devices'))).toBe(false);
  });
});

// `just puppet` claims through `device` on a worktree's first phone command, so it must never
// take a pool device another live worktree owns. With the whole pool owned by one, it refuses
// before touching adb or the emulator, and every owner file is left as it was.
describe('qa.mjs device', () => {
  let home;
  let root;
  let other;

  const ownerFile = (index) =>
    path.join(home, '.futo-notes-qa', 'devices', `android-futo-qa-${index}.json`);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-home-'));
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wt-')));
    other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-other-')));
    execFileSync('git', ['init', '-q', root]);
    fs.mkdirSync(path.dirname(ownerFile(0)), { recursive: true });
    for (let index = 0; index < 7; index++) {
      fs.writeFileSync(ownerFile(index), JSON.stringify({ worktree: other }));
    }
  });

  afterEach(() => {
    for (const dir of [home, root, other]) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never takes a device another live worktree owns', () => {
    const result = spawnSync(process.execPath, [QA, 'device', 'android'], {
      cwd: root,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('owned by live worktrees');
    expect(result.stdout).toBe('');
    for (let index = 0; index < 7; index++) {
      expect(JSON.parse(fs.readFileSync(ownerFile(index), 'utf8')).worktree).toBe(other);
    }
  });

  // A free slot is claimed by name and handed over wiped, as `claim` does. A stub adb and
  // emulator stand in for one running pool emulator; calls.log records what reached adb.
  it('claims a free device and wipes the debug app before handing it out', () => {
    const name = `futo-qa-${slotOf(root) % 7}`;
    fs.rmSync(ownerFile(slotOf(root) % 7));
    const bin = path.join(home, 'bin');
    const calls = path.join(home, 'calls.log');
    fs.mkdirSync(path.join(home, 'sdk', 'emulator'), { recursive: true });
    fs.mkdirSync(bin);
    const stub = (file, body) =>
      fs.writeFileSync(file, `#!/bin/sh\necho "$*" >> ${calls}\n${body}\n`, { mode: 0o755 });
    stub(path.join(home, 'sdk', 'emulator', 'emulator'), `echo ${name}`);
    stub(
      path.join(bin, 'adb'),
      [
        'case "$*" in',
        '  devices) printf "List of devices attached\\nemulator-5554\\tdevice\\n" ;;',
        `  *"emu avd name") printf "${name}\\nOK\\n" ;;`,
        '  *"settings get secure show_ime_with_hard_keyboard") echo 1 ;;',
        '  *" shell ls "*|*" shell pm path "*) exit 1 ;;',
        'esac',
      ].join('\n'),
    );
    const result = spawnSync(process.execPath, [QA, 'device', 'android'], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        ANDROID_HOME: path.join(home, 'sdk'),
        ANDROID_AVD_HOME: path.join(home, 'avd'),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ name, id: 'emulator-5554' });
    const owner = JSON.parse(fs.readFileSync(ownerFile(slotOf(root) % 7), 'utf8'));
    expect(owner).toMatchObject({ worktree: root, id: 'emulator-5554' });
    expect(owner.wipePending).toBeUndefined();
    expect(fs.readFileSync(calls, 'utf8')).toContain('shell rm -rf');
  });
});
