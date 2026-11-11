import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AndroidDevice } from '../android-device.mjs';
import { createAdbClient } from './adbClient.mjs';

// Every invocation is redirected to this owned child. No real adb executable
// or device is reached, including if a production timeout option is missing.
const FAKE_ADB = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.QA_PM_RECORD, JSON.stringify(args) + '\\n');
const command = args.slice(2).join(' ');
if (command === 'emu avd name') {
  process.stdout.write('ci\\nOK\\n');
} else if (command.startsWith('shell pm ')) {
  if (process.env.QA_PM_MODE === 'installed') {
    process.stdout.write('package:com.futo.notes.dev\\npackage:/data/app/fixture/base.apk\\n');
  }
} else {
  throw new Error('unexpected fake adb command: ' + command);
}
`;

describe('bounded Android package presence probes', () => {
  let scratch;
  let fake;
  let record;
  beforeEach(() => {
    vi.stubEnv('ANDROID_AVD_NAME', 'ci');
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'android-package-probe-'));
    fake = path.join(scratch, 'fake-adb.cjs');
    record = path.join(scratch, 'calls.jsonl');
    fs.writeFileSync(fake, FAKE_ADB);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function client(kind, mode) {
    const execFile = (_command, args, options) =>
      execFileSync(process.execPath, [fake, ...args], {
        ...options,
        env: {
          QA_PM_RECORD: record,
          QA_PM_MODE: mode,
        },
      });
    return kind === 'sync'
      ? new AndroidDevice('emulator-5558', { execFile })
      : createAdbClient({ pkg: 'com.futo.notes.dev', serial: 'emulator-5558', execFile });
  }
  const installed = (value, kind) =>
    kind === 'sync'
      ? value.isPackageInstalled('com.futo.notes.dev', { timeoutMs: 5000 })
      : value.isInstalled({ timeoutMs: 5000 });

  it.each(['sync', 'shared'])(
    'returns false only after a completed absent-package query in the %s driver',
    (kind) => {
      expect(installed(client(kind, 'absent'), kind)).toBe(false);
      expect(installed(client(kind, 'installed'), kind)).toBe(true);
    },
  );
  it.each(['sync', 'shared'])(
    'does not add a global timeout to ordinary %s adb commands',
    (kind) => {
      const calls = [];
      const execFile = (_command, args, options) => {
        if (args.includes('avd')) return 'ci\nOK\n';
        calls.push(options);
        return '';
      };
      const value =
        kind === 'sync'
          ? new AndroidDevice('emulator-5558', { execFile })
          : createAdbClient({ pkg: 'com.futo.notes.dev', serial: 'emulator-5558', execFile });
      value.adb(['install', '-r', '/fixture/app.apk']);
      expect(calls).toHaveLength(1);
      expect(calls[0].timeout).toBeUndefined();
    },
  );
});
