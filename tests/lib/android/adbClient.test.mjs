import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A serial is a port, not an emulator identity: another AVD can reuse it.
describe('pooled Android target identity', () => {
  let home;
  let createAdbClient;
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const owner = (name, worktree) => {
    const dir = path.join(home, '.futo-notes-qa', 'devices');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `android-${name}.json`), JSON.stringify({ worktree }));
  };
  const fakeAdb = (name) =>
    vi.fn((_cmd, args) => {
      if (args.join(' ') === '-s emulator-5556 emu avd name') return `${name}\nOK\n`;
      return '';
    });
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'android-identity-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('ANDROID_AVD_NAME', '');
    vi.resetModules();
    ({ createAdbClient } = await import('./adbClient.mjs'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('refuses input when a recycled serial now names a peer-owned AVD', () => {
    owner('futo-qa-1', '/another/live-worktree');
    const execFile = fakeAdb('futo-qa-1');
    const client = createAdbClient({
      pkg: 'com.futo.notes.dev',
      serial: 'emulator-5556',
      execFile,
    });
    expect(() => client.tapPoint(30, 40)).toThrow(/claimed by another worktree/);
    expect(execFile.mock.calls.some(([, args]) => args.includes('input tap 30 40'))).toBe(false);
  });

  it('refuses binary captures as well as shell commands after a claim changes hands', () => {
    owner('futo-qa-1', root);
    const execFile = fakeAdb('futo-qa-1');
    const client = createAdbClient({
      pkg: 'com.futo.notes.dev',
      serial: 'emulator-5556',
      execFile,
    });
    client.tapPoint(30, 40);
    owner('futo-qa-1', '/another/live-worktree');
    expect(() => client.screencapPng()).toThrow(/claimed by another worktree/);
    expect(execFile.mock.calls.some(([, args]) => args.includes('screencap'))).toBe(false);
  });

  it('refuses an exported AVD name that no longer matches the serial', () => {
    vi.stubEnv('ANDROID_AVD_NAME', 'futo-qa-5');
    const execFile = fakeAdb('futo-qa-1');
    const client = createAdbClient({
      pkg: 'com.futo.notes.dev',
      serial: 'emulator-5556',
      execFile,
    });
    expect(() => client.tapPoint(30, 40)).toThrow(/expected futo-qa-5/);
  });

  it('allows the current owner and checks again for every operation', () => {
    owner('futo-qa-1', root);
    const execFile = fakeAdb('futo-qa-1');
    const client = createAdbClient({
      pkg: 'com.futo.notes.dev',
      serial: 'emulator-5556',
      execFile,
    });
    client.tapPoint(30, 40);
    client.keyevent(4);
    expect(execFile.mock.calls.filter(([, args]) => args.includes('avd'))).toHaveLength(2);
  });
  it('also refuses the cross-platform sync harness when the serial belongs to a peer', async () => {
    owner('futo-qa-1', '/another/live-worktree');
    const { AndroidDevice } = await import('../android-device.mjs');
    const execFile = fakeAdb('futo-qa-1');
    const client = new AndroidDevice('emulator-5556', { execFile });
    expect(() => client.shell('echo identity-probe', { allowFailure: true })).toThrow(
      /claimed by another worktree/,
    );
  });

  it('refuses QA readiness when another install replaced this worktree APK', async () => {
    owner('futo-qa-1', root);
    const apkPath = path.join(home, 'own.apk');
    fs.writeFileSync(apkPath, 'our worktree build');
    const execFile = vi.fn((_cmd, args) => {
      if (args.includes('avd')) return 'futo-qa-1\nOK\n';
      if (args.includes('echo ok')) return 'ok';
      if (args.some((arg) => arg.includes('pm path'))) return 'package:/data/app/test/base.apk\n';
      if (args.includes('sha256sum')) return '0'.repeat(64) + '  /data/app/test/base.apk\n';
      return '';
    });
    const { createAndroidDevice } = await import('./device.mjs');
    const device = createAndroidDevice({
      adbClientFactory: (options) =>
        createAdbClient({ ...options, serial: 'emulator-5556', execFile, apkPath }),
    });
    expect(() => device.requireReady()).toThrow(/different APK/);
  });

  it('compares the entire local APK to the device checksum without loading it all at once', async () => {
    const { verifyAndroidApk } = await import('../../../scripts/qa/android-apk.mjs');
    const bytes = Buffer.alloc(1024 * 1024 + 17, 'x');
    const apkPath = path.join(home, 'large.apk');
    fs.writeFileSync(apkPath, bytes);
    const expected = createHash('sha256').update(bytes).digest('hex');
    const execFile = vi.fn((_cmd, args) =>
      args.includes('sha256sum')
        ? expected + '  /data/app/test/base.apk\n'
        : 'package:/data/app/test/base.apk\n',
    );
    expect(verifyAndroidApk({ serial: 'fake-phone', apkPath, execFile })).toBe(expected);
  });

  it.each([
    ['package:/data/app/test/base.apk\npackage:/data/app/test/split.apk\n', 'cannot identify'],
    ['package:/data/app/$(unsafe)/base.apk\n', 'cannot identify'],
  ])('rejects ambiguous or unsafe installed paths %s', async (output, error) => {
    const { verifyAndroidApk } = await import('../../../scripts/qa/android-apk.mjs');
    const apkPath = path.join(home, 'own.apk');
    fs.writeFileSync(apkPath, 'build');
    const execFile = vi.fn(() => output);
    expect(() => verifyAndroidApk({ serial: 'fake-phone', apkPath, execFile })).toThrow(error);
    expect(execFile.mock.calls.some(([, args]) => args.includes('sha256sum'))).toBe(false);
  });
  it('requires ownership for legacy-WebView AVDs as well as pooled devices', () => {
    owner('futo-api28', '/another/live-worktree');
    const execFile = fakeAdb('futo-api28');
    const client = createAdbClient({
      pkg: 'com.futo.notes.dev',
      serial: 'emulator-5556',
      execFile,
    });
    expect(() => client.shell('echo identity-probe')).toThrow(/claimed by another worktree/);
  });
  it('replaces a native field through the shared client and accepts quoted text in the sync sibling', async () => {
    const commands = [];
    const execFile = vi.fn((_command, args) => {
      commands.push(args.at(-1));
      return '';
    });
    const client = createAdbClient({ pkg: 'com.futo.notes.dev', serial: 'fake-phone', execFile });
    client.replaceText('https://10.0.2.2:8445');
    expect(commands).toEqual([
      'input keycombination 113 29',
      'input keyevent 67',
      "input text 'https://10.0.2.2:8445'",
    ]);
    const { AndroidDevice } = await import('../android-device.mjs');
    expect(() =>
      new AndroidDevice('fake-phone', { execFile }).typeReplacingSelection("Bob's note"),
    ).not.toThrow();
    expect(commands.at(-1)).toContain('Bob');
  });
  it('uses the gesture Back driver in the sync harness sibling too', async () => {
    const commands = [];
    const execFile = vi.fn((_command, args) => {
      const text = args.at(-1);
      commands.push(text);
      return text === 'wm size' ? 'Physical size: 720x1600' : '2';
    });
    const { AndroidDevice } = await import('../android-device.mjs');
    new AndroidDevice('fake-phone', { execFile }).pressBack();
    expect(commands.some((command) => command.startsWith('input swipe 2 '))).toBe(true);
    expect(commands).not.toContain('input keyevent 4');
  });
});
