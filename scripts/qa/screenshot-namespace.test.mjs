import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { slotOf } from '../lib/slot.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const scratch = [];
afterEach(() => {
  for (const file of scratch.splice(0)) fs.rmSync(file, { force: true, recursive: true });
});

describe('screenshot recipes', () => {
  it('keeps spaces and shell metacharacters in screenshot names literal', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-recipe-'));
    scratch.push(bin);
    const capture = path.join(bin, 'captured-path');
    const markerName = `screenshot-injection-${process.pid}-${Date.now()}`;
    const marker = path.join(root, markerName);
    scratch.push(marker);
    const stub = path.join(bin, 'xcrun');
    fs.writeFileSync(
      stub,
      `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.CAPTURE_PATH, process.argv.at(-1));\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, 'adb'), `#!${process.execPath}\nprocess.exit(0);\n`, {
      mode: 0o755,
    });
    const name = `story with spaces $(touch ${markerName})`;
    const device = `papercut-device-${process.pid}`;
    const result = spawnSync('just', ['sim-screenshot', name], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CAPTURE_PATH: capture,
        SIM: device,
      },
    });
    const screenshotDir = path.join(root, 'test-screenshots', 'ios', `s${slotOf(root)}`, device);
    scratch.push(screenshotDir);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(capture, 'utf8')).toBe(
      `test-screenshots/ios/s${slotOf(root)}/${device}/${name}.png`,
    );
    expect(fs.existsSync(marker)).toBe(false);

    const androidDevice = `papercut-android-${process.pid}`;
    const androidResult = spawnSync('just', ['emu-screenshot', name], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        ANDROID_SERIAL: androidDevice,
      },
    });
    const androidDir = path.join(
      root,
      'test-screenshots',
      'android',
      `s${slotOf(root)}`,
      androidDevice,
    );
    scratch.push(androidDir);
    expect(androidResult.status, androidResult.stderr).toBe(0);
    expect(fs.existsSync(path.join(androidDir, `${name}.png`))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
