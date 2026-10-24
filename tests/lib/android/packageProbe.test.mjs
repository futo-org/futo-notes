import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AndroidDevice } from '../android-device.mjs';
import { createAdbClient } from './adbClient.mjs';

// Every invocation is redirected to this owned child. No real adb executable
// or device is reached, including if a production timeout option is missing.
const FAKE_ADB = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.QA_PM_RECORD, JSON.stringify(args) + '\\n');
const command = args.slice(2).join(' ');
if (command === 'get-state') {
  if (process.env.QA_PM_STATE === 'stall') {
    process.on('SIGTERM', () => {});
    setTimeout(() => fs.writeFileSync(process.env.QA_PM_FINISHED, 'transport finished'), 3500);
  } else process.stdout.write(process.env.QA_PM_STATE + '\\n');
} else if (command.startsWith('shell pm ')) {
  if (process.env.QA_PM_MODE === 'stall') {
    process.on('SIGTERM', () => {});
    setTimeout(() => fs.writeFileSync(process.env.QA_PM_FINISHED, 'finished'), 1200);
  } else if (process.env.QA_PM_MODE === 'installed') {
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
  let finished;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'android-package-probe-'));
    fake = path.join(scratch, 'fake-adb.cjs');
    record = path.join(scratch, 'calls.jsonl');
    finished = path.join(scratch, 'pm-finished');
    fs.writeFileSync(fake, FAKE_ADB);
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  function client(kind, mode = 'stall', state = 'device') {
    const execFile = (_command, args, options) =>
      execFileSync(process.execPath, [fake, ...args], {
        ...options,
        env: {
          QA_PM_RECORD: record,
          QA_PM_FINISHED: finished,
          QA_PM_MODE: mode,
          QA_PM_STATE: state,
        },
      });
    return kind === 'sync'
      ? new AndroidDevice('fixture-phone', { execFile })
      : createAdbClient({ pkg: 'com.futo.notes.dev', serial: 'fixture-phone', execFile });
  }
  const installed = (value, kind) =>
    kind === 'sync'
      ? value.isPackageInstalled('com.futo.notes.dev', { timeoutMs: 250 })
      : value.isInstalled({ timeoutMs: 250 });

  it.each(['sync', 'shared'])(
    'distinguishes a stalled PM from responsive adb in the %s driver',
    (kind) => {
      expect(() => installed(client(kind), kind)).toThrow(
        /Package Manager.*timed out[\s\S]*get-state=device/,
      );
      expect(fs.existsSync(finished)).toBe(false);
      const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls.some((args) => args.slice(2).join(' ') === 'get-state')).toBe(true);
    },
  );

  it.each(['sync', 'shared'])(
    'reports an offline transport separately in the %s driver',
    (kind) => {
      expect(() => installed(client(kind, 'stall', 'offline'), kind)).toThrow(/get-state=offline/);
      expect(fs.existsSync(finished)).toBe(false);
    },
  );

  it.each(['sync', 'shared'])(
    'returns false only after a completed absent-package query in the %s driver',
    (kind) => {
      expect(installed(client(kind, 'absent'), kind)).toBe(false);
      expect(installed(client(kind, 'installed'), kind)).toBe(true);
    },
  );
  it('also bounds the transport diagnostic when adb itself stops responding', () => {
    expect(() => installed(client('shared', 'stall', 'stall'), 'shared')).toThrow(
      /transport probe also timed out/,
    );
    expect(fs.existsSync(finished)).toBe(false);
  }, 10_000);

  it.each(['sync', 'shared'])(
    'does not add a global timeout to ordinary %s adb commands',
    (kind) => {
      const calls = [];
      const execFile = (_command, _args, options) => {
        calls.push(options);
        return '';
      };
      const value =
        kind === 'sync'
          ? new AndroidDevice('fixture-phone', { execFile })
          : createAdbClient({ pkg: 'com.futo.notes.dev', serial: 'fixture-phone', execFile });
      value.adb(['install', '-r', '/fixture/app.apk']);
      expect(calls).toHaveLength(1);
      expect(calls[0].timeout).toBeUndefined();
    },
  );
});
