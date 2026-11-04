import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { slotOf } from '../lib/slot.mjs';

const QA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../qa.mjs');

// Run the public CLI against fake platform executables, never CoreSimulator.
// Subprocess-driven file: cases chain several scripts/qa.mjs spawns, each bounded at 10s. The 5s default went red on loaded
// CI runners (audit 2026-11), so the file timeout is set to 30s to cover that bound.
vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(process.platform !== 'darwin')('preferred pooled iOS QA claims', () => {
  let scratch;
  let root;
  let peer;
  let env;
  const run = (cwd, ...args) =>
    spawnSync(process.execPath, [QA, 'claim', ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
  const commands = () =>
    fs.existsSync(env.QA_TOOL_LOG) ? fs.readFileSync(env.QA_TOOL_LOG, 'utf8') : '';
  const owners = () => {
    const dir = path.join(scratch, '.futo-notes-qa/devices');
    return fs.existsSync(dir)
      ? Object.fromEntries(
          fs
            .readdirSync(dir)
            .sort()
            .map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]),
        )
      : {};
  };
  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ios-selection-')));
    root = path.join(scratch, 'root');
    peer = path.join(scratch, 'peer');
    for (const dir of [root, peer]) {
      fs.mkdirSync(dir);
      execFileSync('git', ['init', '-q', dir]);
    }
    const bin = path.join(scratch, 'bin');
    fs.mkdirSync(bin);
    const devices = Array.from({ length: 7 }, (_, index) => ({
      name: `futo-qa-${index}`,
      udid: `pool-id-${index}`,
      state: 'Booted',
      isAvailable: true,
    }));
    devices.push({
      name: 'My personal iPhone',
      udid: 'personal-id',
      state: 'Booted',
      isAvailable: true,
    });
    fs.writeFileSync(
      path.join(scratch, 'simulators.json'),
      JSON.stringify({ devices: { runtime: devices } }),
    );
    const adapter = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.QA_TOOL_LOG, JSON.stringify([tool, ...args]) + '\\n');
if (tool === 'xcrun' && args.join(' ') === 'simctl list -j devices') {
  if (process.env.QA_LIST_GATE) {
    fs.writeFileSync(process.env.QA_LIST_GATE + '.entered', '');
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(process.env.QA_LIST_GATE + '.release')) {
      if (Date.now() > deadline) process.exit(1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  process.stdout.write(fs.readFileSync(process.env.QA_SIMULATORS));
} else if (tool === 'xcode-select') {
  console.log('/fake/Xcode');
} else if (['xcrun', 'open', 'osascript'].includes(tool)) {
  // Simulators begin booted; no real command is ever executed.
} else {
  console.error('Unexpected platform command'); process.exit(1);
}
`;
    for (const tool of ['xcrun', 'open', 'xcode-select', 'osascript', 'adb'])
      fs.writeFileSync(path.join(bin, tool), adapter, { mode: 0o755 });
    env = {
      ...process.env,
      HOME: scratch,
      ANDROID_HOME: path.join(scratch, 'absent-sdk'),
      PATH: bin + path.delimiter + process.env.PATH,
      QA_TOOL_LOG: path.join(scratch, 'tools.log'),
      QA_SIMULATORS: path.join(scratch, 'simulators.json'),
    };
  });
  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  // Schedule a complete second public invocation at the first allocator lock open.
  // This catches callers that cached absence before entering the critical section.
  it.each(['claim', 'device'])(
    '%s reuses a preferred claim completed immediately before acquiring its lock',
    (command) => {
      const index = (slotOf(root) + 1) % 7;
      const preload = path.join(scratch, 'schedule.mjs');
      fs.writeFileSync(
        preload,
        `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const original = fs.openSync;
let fired = false;
fs.openSync = function(file, ...args) {
  if (!fired && file === ${JSON.stringify(path.join(scratch, '.futo-notes-qa/ios-allocation.lock'))}) {
    fired = true;
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawnSync(process.execPath, [${JSON.stringify(QA)}, 'claim', 'ios', '--sim', 'futo-qa-${index}'], { cwd: ${JSON.stringify(root)}, env, encoding: 'utf8' });
    if (child.status !== 0) throw new Error(child.stderr);
    fs.writeFileSync(process.env.QA_TOOL_LOG, '');
  }
  return original.call(this, file, ...args);
};
`,
      );
      const result = spawnSync(process.execPath, [QA, command, 'ios'], {
        cwd: root,
        env: { ...env, NODE_OPTIONS: `--import=${preload}` },
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        command === 'device'
          ? JSON.stringify({ name: `futo-qa-${index}`, id: `pool-id-${index}` }) + '\n'
          : `export SIM=pool-id-${index}\n`,
      );
      expect(Object.keys(owners())).toEqual([`ios-futo-qa-${index}.json`]);
      expect(commands()).not.toMatch(/uninstall|keychain|shutdown|erase/);
    },
  );

  it.each([
    ['claim', undefined],
    ['device', undefined],
    ['claim', 'futo-qa-5'],
  ])('%s refuses lock replacement at owner persistence (selector %s)', (command, selector) => {
    const preload = path.join(scratch, 'replace.mjs');
    const lock = path.join(scratch, '.futo-notes-qa/ios-allocation.lock');
    fs.writeFileSync(
      preload,
      `
import fs from 'node:fs';
const original = fs.mkdirSync;
let fired = false;
fs.mkdirSync = function(file, ...args) {
  if (!fired && file === ${JSON.stringify(path.join(scratch, '.futo-notes-qa/devices'))}) {
    fired = true;
    fs.writeFileSync(${JSON.stringify(lock)}, 'FOREIGN LOCK');
  }
  return original.call(this, file, ...args);
};
`,
    );
    const result = spawnSync(
      process.execPath,
      [QA, command, 'ios', ...(selector ? ['--sim', selector] : [])],
      {
        cwd: root,
        env: { ...env, NODE_OPTIONS: `--import=${preload}` },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expectRefused(result, {});
    expect(result.stderr).toContain('lock identity changed');
    expect(fs.readFileSync(lock, 'utf8')).toBe('FOREIGN LOCK');
  });

  it('device reuses an ordinary completed preferred claim without a handover wipe', () => {
    expect(run(root, 'ios', '--sim', 'futo-qa-5').status).toBe(0);
    const before = owners();
    fs.writeFileSync(env.QA_TOOL_LOG, '');
    const result = spawnSync(process.execPath, [QA, 'device', 'ios'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ name: 'futo-qa-5', id: 'pool-id-5' });
    expect(owners()).toEqual(before);
    expect(commands()).not.toMatch(/uninstall|keychain|shutdown|erase/);
  });

  it('device refuses an extant allocation lock even when its preferred claim is already held', () => {
    expect(run(root, 'ios', '--sim', 'futo-qa-5').status).toBe(0);
    const before = owners();
    const lock = path.join(scratch, '.futo-notes-qa/ios-allocation.lock');
    fs.writeFileSync(lock, 'OTHER ALLOCATOR');
    fs.writeFileSync(env.QA_TOOL_LOG, '');
    const result = spawnSync(process.execPath, [QA, 'device', 'ios'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 10000,
    });
    expectRefused(result, before);
    expect(result.stderr).toContain('another iOS allocation');
    expect(commands()).toBe('');
    expect(fs.readFileSync(lock, 'utf8')).toBe('OTHER ALLOCATOR');
  });

  it('selects exactly the requested existing pooled simulator by name', () => {
    const result = run(root, 'ios', '--sim', 'futo-qa-5');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('export SIM=pool-id-5\n');
    expect(Object.keys(owners())).toEqual(['ios-futo-qa-5.json']);
    expect(commands()).toContain('["xcrun","simctl","uninstall","pool-id-5","com.futo.notes.dev"]');
    expect(commands()).not.toMatch(/pool-id-[012346]|personal-id/);
  });

  it('resolves an exact pooled simulator ID to its canonical owner name', () => {
    const result = run(root, 'ios', '--sim', 'pool-id-2');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('export SIM=pool-id-2\n');
    expect(Object.keys(owners())).toEqual(['ios-futo-qa-2.json']);
  });

  const expectRefused = (result, before) => {
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(owners()).toEqual(before);
    const calls = commands()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(
      calls.every((call) => JSON.stringify(call) === '["xcrun","simctl","list","-j","devices"]'),
    ).toBe(true);
  };

  it.each([
    'unknown-id',
    'My personal iPhone',
    'personal-id',
    'futo-qa-7',
    'futo-qa-',
    'pool-id',
    'futo-api28',
  ])(
    'refuses nonpool or inexact selector %s without lease changes or device actions',
    (selector) => {
      expectRefused(run(root, 'ios', '--sim', selector), {});
    },
  );

  it.each([
    ['android', '--sim', 'futo-qa-1'],
    ['all', '--sim', 'futo-qa-1'],
    ['--sim', 'futo-qa-1'],
    ['ios', '--sim'],
    ['ios', '--sim', '--reboot'],
    ['ios', '--sim', 'futo-qa-1', '--sim', 'futo-qa-2'],
    ['ios', '--sim', 'futo-qa-1', '--erase'],
    ['ios', '--sim', 'futo-qa-1', '--avd', 'futo-api28'],
  ])('refuses unsupported selector arguments %j before any device actions', (args) => {
    expectRefused(run(root, ...args), {});
    expect(commands()).toBe('');
  });

  it('refuses a live sibling owner without falling back to a free pool member', () => {
    const first = run(peer, 'ios', '--sim', 'futo-qa-1');
    expect(first.status, first.stderr).toBe(0);
    const before = owners();
    fs.writeFileSync(env.QA_TOOL_LOG, '');
    const refused = run(root, 'ios', '--sim', 'pool-id-1');
    expectRefused(refused, before);
    expect(refused.stderr).toContain('another live worktree');
  });

  it('refuses to move an existing claim and preserves a repeated claim without wiping', () => {
    expect(run(root, 'ios', '--sim', 'futo-qa-1').status).toBe(0);
    const before = owners();
    fs.writeFileSync(env.QA_TOOL_LOG, '');
    const refused = run(root, 'ios', '--sim', 'futo-qa-4');
    expectRefused(refused, before);
    expect(refused.stderr).toContain('already owns a different');
    fs.writeFileSync(env.QA_TOOL_LOG, '');
    const repeated = run(root, 'ios', '--sim', 'pool-id-1');
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(owners()).toEqual(before);
    expect(commands()).not.toMatch(/uninstall|keychain|shutdown|erase/);
  });

  it('keeps the default slot-based allocation when no selector is given', () => {
    const result = run(root, 'ios');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`export SIM=pool-id-${slotOf(root) % 7}\n`);
    expect(Object.keys(owners())).toEqual([`ios-futo-qa-${slotOf(root) % 7}.json`]);
  });

  it('keeps default linear probing past a live sibling when no selector is given', () => {
    const index = slotOf(root) % 7;
    const sibling = run(peer, 'ios', '--sim', `futo-qa-${index}`);
    expect(sibling.status, sibling.stderr).toBe(0);
    fs.writeFileSync(env.QA_TOOL_LOG, '');
    const result = run(root, 'ios');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`export SIM=pool-id-${(index + 1) % 7}\n`);
    expect(commands()).not.toContain(`"pool-id-${index}"`);
  });

  it.each(['missing', 'unavailable', 'duplicate'])(
    'refuses a %s pool simulator before claiming',
    (change) => {
      const inventory = JSON.parse(fs.readFileSync(env.QA_SIMULATORS, 'utf8'));
      if (change === 'missing')
        inventory.devices.runtime = inventory.devices.runtime.filter(
          (device) => device.name !== 'futo-qa-5',
        );
      if (change === 'unavailable') inventory.devices.runtime[5].isAvailable = false;
      if (change === 'duplicate')
        inventory.devices.runtime.push({ ...inventory.devices.runtime[5], udid: 'duplicate-id' });
      fs.writeFileSync(env.QA_SIMULATORS, JSON.stringify(inventory));
      expectRefused(run(root, 'ios', '--sim', 'futo-qa-5'), {});
    },
  );

  it('serializes concurrent preferences in the same worktree before selection or owner writes', async () => {
    const gate = path.join(scratch, 'gate');
    const child = spawn(process.execPath, [QA, 'claim', 'ios', '--sim', 'futo-qa-5'], {
      cwd: root,
      env: { ...env, QA_LIST_GATE: gate },
      stdio: 'pipe',
    });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      await vi.waitFor(() => expect(fs.existsSync(gate + '.entered')).toBe(true));
      const refused = run(root, 'ios', '--sim', 'futo-qa-6');
      expectRefused(refused, {});
      expect(refused.stderr).toContain('another iOS allocation');
    } finally {
      fs.writeFileSync(gate + '.release', '');
      expect(await exited, stderr).toBe(0);
    }
    expect(Object.keys(owners())).toEqual(['ios-futo-qa-5.json']);
  });
});
