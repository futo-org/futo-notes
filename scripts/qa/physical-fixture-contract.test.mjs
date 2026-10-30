// Public ownership/lifecycle contracts. Only OS and process observations are
// injected; malformed input must not create or change retained ownership.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { holdLease, releaseLease } from './physical-fixture-lease.mjs';
import { executePhysicalFixture } from './physical-fixture.mjs';
import { runPhysicalFixtureCLI } from './physical-fixture-cli.mjs';
import { setup } from './physical-fixture-test-data.mjs';

it.each([
  'runID',
  'nonce',
  'sourceSHA',
  'sourceFingerprint',
  'buildFingerprint',
  'coreDeviceID',
  'deviceUDID',
])('refuses a singleton-array keeper %s before creating ownership', async (field) => {
  const t = setup(false);
  try {
    const template = { ...t.plan };
    delete template.ownerPID;
    template[field] = [template[field]];
    await expect(
      holdLease(template, {
        ...t.runtime.leaseRuntime,
        // Bound the old accepting behavior instead of leaving its keeper live.
        report: () => releaseLease({ ...template, ownerPID: process.pid }, t.runtime.leaseRuntime),
      }),
    ).rejects.toThrow(/fixed, bounded/);
    expect(existsSync(t.runtime.leaseRuntime.directory)).toBe(false);
    expect(existsSync(t.runtime.scratch)).toBe(false);
  } finally {
    t.clean();
  }
});

const textFields = [
  'host',
  'deviceUDID',
  'coreDeviceID',
  'worktree',
  'sourceSHA',
  'sourceFingerprint',
  'runID',
  'nonce',
  'bundleID',
  'runnerBundleID',
  'buildFingerprint',
];
const malformed = [
  ['array', (value) => [value]],
  ['nested array', (value) => [[value]]],
  ['null', () => null],
  ['boolean', () => true],
  ['wrong primitive', (value) => (typeof value === 'number' ? String(value) : 1)],
  ['object', () => ({})],
  ['coercible object', (value) => ({ toString: () => value })],
  ['boxed', (value) => Object(value)],
];
function snapshot(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return stat.isDirectory()
    ? {
        mode: stat.mode,
        entries: Object.fromEntries(
          readdirSync(path)
            .sort()
            .map((name) => [name, snapshot(join(path, name))]),
        ),
      }
    : { mode: stat.mode, bytes: readFileSync(path).toString('base64') };
}

it.each([...textFields, 'formatVersion', 'seconds'])(
  'requires primitive keeper %s for every malformed type before any ownership observation',
  async (field) => {
    for (const [, change] of malformed) {
      const t = setup(false);
      const identity = vi.fn(t.runtime.leaseRuntime.processIdentity);
      const report = vi.fn();
      try {
        const template = { ...t.plan };
        delete template.ownerPID;
        template[field] = change(template[field]);
        report.mockImplementation(() =>
          releaseLease({ ...template, ownerPID: process.pid }, t.runtime.leaseRuntime),
        );
        const before = snapshot(t.directory);
        await expect(
          holdLease(template, { ...t.runtime.leaseRuntime, processIdentity: identity, report }),
        ).rejects.toThrow(/fixed, bounded/);
        expect(identity).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
        expect(snapshot(t.directory)).toEqual(before);
      } finally {
        t.clean();
      }
    }
  },
);

it.each(['capture', 'read', 'close'])(
  'rejects all typed-malformed %s manifests before locks or executors',
  async (operation) => {
    const t = setup();
    try {
      const identity = vi.spyOn(t.runtime.leaseRuntime, 'processIdentity');
      for (const method of Object.keys(t.runtime.executor)) vi.spyOn(t.runtime.executor, method);
      const before = snapshot(t.directory);
      for (const field of [...textFields, 'formatVersion', 'seconds', 'ownerPID']) {
        for (const [, change] of malformed) {
          const plan = { ...t.plan, [field]: change(t.plan[field]) };
          await expect(executePhysicalFixture(operation, plan, t.runtime)).rejects.toThrow(
            /fixed, bounded/,
          );
        }
      }
      expect(identity).not.toHaveBeenCalled();
      for (const method of Object.values(t.runtime.executor)) expect(method).not.toHaveBeenCalled();
      expect(snapshot(t.directory)).toEqual(before);
    } finally {
      t.clean();
    }
  },
);

it.each(['capture', 'read', 'close'])(
  'rejects operator JSON malformed values on %s with retained lease and evidence unchanged',
  async (operation) => {
    const t = setup();
    try {
      const output = join(t.runtime.scratch, t.plan.runID);
      mkdirSync(t.runtime.scratch, { mode: 0o700 });
      mkdirSync(output, { mode: 0o700 });
      const path = join(output, 'manifest.json');
      const identity = vi.spyOn(t.runtime.leaseRuntime, 'processIdentity');
      for (const method of Object.keys(t.runtime.executor)) vi.spyOn(t.runtime.executor, method);
      for (const field of [...textFields, 'formatVersion', 'seconds', 'ownerPID']) {
        // JSON serializes boxed primitives into valid primitives, so direct JS
        // rejection above covers boxes; the operator cases preserve JSON types.
        for (const [, change] of malformed.slice(0, -1)) {
          writeFileSync(path, JSON.stringify({ ...t.plan, [field]: change(t.plan[field]) }), {
            mode: 0o600,
          });
          const before = snapshot(t.directory);
          await expect(
            runPhysicalFixtureCLI(
              [
                operation,
                operation === 'capture' ? '--manifest' : '--run',
                operation === 'capture' ? path : t.plan.runID,
              ],
              t.runtime,
            ),
          ).rejects.toThrow(/fixed, bounded|requested run/);
          expect(snapshot(t.directory)).toEqual(before);
        }
      }
      expect(identity).not.toHaveBeenCalled();
      for (const method of Object.values(t.runtime.executor)) expect(method).not.toHaveBeenCalled();
    } finally {
      t.clean();
    }
  },
);

it.each(['capture', 'read', 'close'])(
  'refuses coercible %s arguments at the public CLI boundary',
  async (operation) => {
    const t = setup();
    try {
      const path = join(t.directory, 'operator.json');
      writeFileSync(path, JSON.stringify(t.plan), { mode: 0o600 });
      for (const [, change] of malformed) {
        const before = snapshot(t.directory);
        await expect(
          runPhysicalFixtureCLI(
            [
              operation,
              operation === 'capture' ? '--manifest' : '--run',
              change(operation === 'capture' ? path : t.plan.runID),
            ],
            t.runtime,
          ),
        ).rejects.toThrow(/physical-fixture capture/);
        expect(snapshot(t.directory)).toEqual(before);
      }
    } finally {
      t.clean();
    }
  },
);

it.each([
  'runID',
  'nonce',
  'sourceSHA',
  'sourceFingerprint',
  'buildFingerprint',
  'coreDeviceID',
  'deviceUDID',
])('refuses a keeper %s ending in a line terminator before namespace creation', async (field) => {
  for (const ending of ['\n', '\r', '\u2028', '\u2029']) {
    const t = setup(false);
    try {
      const template = { ...t.plan };
      delete template.ownerPID;
      template[field] += ending;
      await expect(
        holdLease(template, {
          ...t.runtime.leaseRuntime,
          report: () =>
            releaseLease({ ...template, ownerPID: process.pid }, t.runtime.leaseRuntime),
        }),
      ).rejects.toThrow(/fixed, bounded/);
      expect(existsSync(t.runtime.leaseRuntime.directory)).toBe(false);
    } finally {
      t.clean();
    }
  }
});

it.each(
  ['read', 'close'].flatMap((operation) =>
    ['captured', 'failed'].flatMap((status) =>
      ['artifactSHA256', 'rawReadSHA256'].map((field) => [operation, status, field]),
    ),
  ),
)(
  'refuses typed-malformed %s %s %s without changing evidence or ownership',
  async (operation, status, field) => {
    const t = setup();
    try {
      await executePhysicalFixture('capture', t.plan, t.runtime);
      const path = join(t.runtime.scratch, t.plan.runID, 'receipt.json');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      receipt.status = status;
      if (status === 'failed') receipt.error = 'Retained mock failure';
      for (const method of Object.keys(t.runtime.executor)) vi.spyOn(t.runtime.executor, method);
      for (const [, change] of malformed.slice(0, -1)) {
        const mutated =
          field === 'artifactSHA256'
            ? { ...receipt, artifactSHA256: change(receipt.artifactSHA256) }
            : {
                ...receipt,
                rawReads: [
                  {
                    path: join(
                      t.runtime.scratch,
                      t.plan.runID,
                      'failed-read-650d54cc-6339-4d62-b550-834bfbb8d7aa/capture.json',
                    ),
                    sha256: change('a'.repeat(64)),
                  },
                ],
              };
        writeFileSync(path, JSON.stringify(mutated));
        const before = snapshot(t.directory);
        await expect(executePhysicalFixture(operation, t.plan, t.runtime)).rejects.toThrow(
          /receipt/,
        );
        expect(snapshot(t.directory)).toEqual(before);
      }
      for (const method of Object.values(t.runtime.executor)) expect(method).not.toHaveBeenCalled();
    } finally {
      t.clean();
    }
  },
);

it.each(['version', 'url'])(
  'refuses a typed-malformed installation %s before the next executor or authoritative installation write',
  async (field) => {
    for (const [, change] of malformed) {
      const t = setup();
      try {
        const install = t.runtime.executor.installFixture;
        t.runtime.executor.installFixture = () => {
          const item = install();
          item[field] = change(item[field]);
          return item;
        };
        await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
          /installation receipt/,
        );
        expect(t.effects).toEqual(['install-fixture']);
        const receipt = JSON.parse(
          readFileSync(join(t.runtime.scratch, t.plan.runID, 'receipt.json'), 'utf8'),
        );
        expect(receipt.status).toBe('failed');
        expect(receipt.installations).toEqual([]);
      } finally {
        t.clean();
      }
    }
  },
);

it('keeps the primitive keeper and public capture/read/close controls usable', async () => {
  const keeper = setup(false);
  try {
    const template = { ...keeper.plan };
    delete template.ownerPID;
    let manifest;
    const stopped = await holdLease(template, {
      ...keeper.runtime.leaseRuntime,
      report(resource) {
        manifest = JSON.parse(readFileSync(resource.manifest, 'utf8'));
        releaseLease(manifest, keeper.runtime.leaseRuntime);
      },
    });
    expect(manifest).toEqual({ ...template, ownerPID: process.pid });
    expect(stopped.released).toBe(template.runID);
  } finally {
    keeper.clean();
  }
  const t = setup();
  try {
    const path = join(t.directory, 'operator.json');
    writeFileSync(path, JSON.stringify(t.plan), { mode: 0o600 });
    expect((await runPhysicalFixtureCLI(['capture', '--manifest', path], t.runtime)).status).toBe(
      'captured',
    );
    expect(
      (await runPhysicalFixtureCLI(['read', '--run', t.plan.runID], t.runtime)).receipt.status,
    ).toBe('captured');
    expect((await runPhysicalFixtureCLI(['close', '--run', t.plan.runID], t.runtime)).status).toBe(
      'closed',
    );
  } finally {
    t.clean();
  }
});

it.each([
  ['os', []],
  ['os', [['iOS']]],
  ['os', null],
  ['os', true],
  ['os', 1],
  ['os', {}],
  ['traits', []],
  ['traits', [[]]],
  ['traits', null],
  ['traits', true],
  ['traits', 1],
  ['traits', 'iOS'],
])(
  'refuses typed-malformed raw artifact %s=%j before recording capture success',
  async (field, value) => {
    const t = setup();
    try {
      const copy = t.runtime.executor.copyArtifact;
      t.runtime.executor.copyArtifact = () =>
        JSON.stringify({ ...JSON.parse(copy()), [field]: value });
      await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
        /incomplete/,
      );
      const receipt = JSON.parse(
        readFileSync(join(t.runtime.scratch, t.plan.runID, 'receipt.json'), 'utf8'),
      );
      expect(receipt.status).toBe('failed');
      expect(receipt.artifactSHA256).toBeUndefined();
    } finally {
      t.clean();
    }
  },
);
