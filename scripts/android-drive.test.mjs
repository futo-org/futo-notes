import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const entry = path.join(root, 'scripts/android-drive.mjs');

describe('Android driver command routing', () => {
  let scratch;
  let env;
  let loader;
  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'android-drive-cli-'));
    loader = path.join(scratch, 'loader.mjs');
    const target = pathToFileURL(path.join(root, 'tests/lib/android/device.mjs')).href;
    const stub = `import fs from 'node:fs';
const record = (value) => fs.writeFileSync(process.env.DRIVER_TEST_LOG, JSON.stringify(value));
export const createAndroidDevice = () => ({
 requireReady() {},
 async tap() { throw new Error('missing requested label on current screen'); },
 back() { record({ action: 'back' }); },
 typeText(text, options) { record({ action: 'text', text, options }); },
 adb: { keyevent(code) { record({ action: 'key', code }); } },
 invalidateUi() {},
});`;
    fs.writeFileSync(
      loader,
      `export async function load(url, context, nextLoad) {
 if (url === ${JSON.stringify(target)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(stub)} };
 return nextLoad(url, context);
}`,
    );
    const bin = path.join(scratch, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'adb'), '#!/bin/sh\necho unexpected real adb >&2\nexit 1\n', {
      mode: 0o755,
    });
    env = {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      DRIVER_TEST_LOG: path.join(scratch, 'actions.json'),
    };
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const run = (...args) =>
    spawnSync(process.execPath, ['--loader', loader, entry, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  const action = () => JSON.parse(fs.readFileSync(env.DRIVER_TEST_LOG, 'utf8'));

  it('fails the CLI when the requested tap label is absent', () => {
    const result = run('tap', 'Settings');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing requested label');
    expect(fs.existsSync(env.DRIVER_TEST_LOG)).toBe(false);
  });

  it.each(['back', '4', 'KEYCODE_BACK'])('routes key %s through the device Back driver', (key) => {
    const result = run('key', key);
    expect(result.status, result.stderr).toBe(0);
    expect(action()).toEqual({ action: 'back' });
  });

  it('supports replacing a focused native field without changing append behavior', () => {
    expect(run('text', '--replace', 'https://10.0.2.2:8445').status).toBe(0);
    expect(action()).toEqual({
      action: 'text',
      text: 'https://10.0.2.2:8445',
      options: { replace: true },
    });
    expect(run('text', 'suffix').status).toBe(0);
    expect(action()).toEqual({ action: 'text', text: 'suffix', options: { replace: false } });
  });
});
