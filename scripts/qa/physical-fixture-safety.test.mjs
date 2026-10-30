import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import process from 'node:process';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acquireLease, releaseLease, holdLease } from './physical-fixture-lease.mjs';
import { executePhysicalFixture } from './physical-fixture.mjs';
import { runPhysicalFixtureCLI } from './physical-fixture-cli.mjs';
import { runID, nonce, setup } from './physical-fixture-test-data.mjs';

describe('retained physical evidence trust boundary', () => {
  it('refuses read and close after the retained run becomes nonprivate, without releasing ownership', async () => {
    const t = setup();
    try {
      await executePhysicalFixture('capture', t.plan, t.runtime);
      const output = join(t.runtime.scratch, runID);
      chmodSync(output, 0o777);
      const before = [...t.effects];
      for (const operation of ['read', 'close'])
        await expect(executePhysicalFixture(operation, t.plan, t.runtime)).rejects.toThrow(
          /private|evidence/,
        );
      expect(t.effects).toEqual(before);
      expect(() => acquireLease(t.plan, t.runtime.leaseRuntime)).toThrow(/reserved/);
    } finally {
      t.clean();
    }
  });
});

it.each(['read', 'close'])(
  'binds requested %s run to the retained manifest before any executor or release',
  async (operation) => {
    const t = setup();
    try {
      await executePhysicalFixture('capture', t.plan, t.runtime);
      const requested = '650D54CC-6339-4D62-B550-834BFBB8D7AB';
      const alias = join(t.runtime.scratch, requested);
      mkdirSync(alias, { mode: 0o700 });
      writeFileSync(join(alias, 'manifest.json'), JSON.stringify(t.plan), { mode: 0o600 });
      const effects = [...t.effects];
      await expect(
        runPhysicalFixtureCLI([operation, '--run', requested], t.runtime),
      ).rejects.toThrow(/requested run/);
      expect(t.effects).toEqual(effects);
      expect(() => acquireLease(t.plan, t.runtime.leaseRuntime)).toThrow(/reserved/);
    } finally {
      t.clean();
    }
  },
);

it.each([
  { status: undefined },
  { status: 'unknown' },
  { status: 'running' },
  { nonce: undefined },
  { nonce: runID },
  { formatVersion: undefined },
  { formatVersion: 99 },
  { runID: nonce },
  { acceptance: undefined },
  { installations: undefined },
  { output: '/other' },
  { artifactSHA256: undefined },
  { deviceObservations: undefined },
  { extra: true },
])('retains the lease on an incomplete or unknown terminal close receipt %j', async (change) => {
  const t = setup();
  try {
    await executePhysicalFixture('capture', t.plan, t.runtime);
    const path = join(t.runtime.scratch, runID, 'receipt.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...receipt, ...change }));
    await expect(executePhysicalFixture('close', t.plan, t.runtime)).rejects.toThrow(
      /receipt|unknown|unfinished/,
    );
    expect(() => acquireLease(t.plan, t.runtime.leaseRuntime)).toThrow(/reserved/);
  } finally {
    t.clean();
  }
});

it.each([
  { port: 4567 },
  { environment: { ARBITRARY: 'value' } },
  { output: '/other' },
  { formatVersion: 99 },
  { seconds: undefined },
  { bundleID: 'com.futo.notes.dev' },
])(
  'refuses malformed keeper templates before namespace, lease or authoritative manifest creation %j',
  async (change) => {
    const t = setup(false);
    const template = { ...t.plan };
    delete template.ownerPID;
    try {
      await expect(
        holdLease(
          { ...template, ...change },
          {
            ...t.runtime.leaseRuntime,
            report: (resource) =>
              releaseLease(
                JSON.parse(readFileSync(resource.manifest, 'utf8')),
                t.runtime.leaseRuntime,
              ),
          },
        ),
      ).rejects.toThrow(/manifest|template/);
      expect(existsSync(t.runtime.leaseRuntime.directory)).toBe(false);
      expect(t.effects).toEqual([]);
    } finally {
      t.clean();
    }
  },
);

it.each([
  'parent-mode',
  'run-mode',
  'manifest-mode',
  'receipt-mode',
  'capture-mode',
  'run-symlink',
  'manifest-symlink',
  'receipt-symlink',
  'capture-symlink',
  'attachment-symlink',
  'attachment-mode',
])('refuses retained %s before read, close or release and preserves evidence', async (change) => {
  const t = setup();
  try {
    await executePhysicalFixture('capture', t.plan, t.runtime);
    const output = join(t.runtime.scratch, runID);
    let path = change.startsWith('parent')
      ? t.runtime.scratch
      : change.startsWith('run')
        ? output
        : join(
            output,
            change.startsWith('manifest')
              ? 'manifest.json'
              : change.startsWith('receipt')
                ? 'receipt.json'
                : 'capture.json',
          );
    if (change.startsWith('attachment')) {
      path = join(output, 'attachments');
      mkdirSync(path, { mode: 0o700 });
    }
    if (change.endsWith('mode')) chmodSync(path, lstatSync(path).isDirectory() ? 0o777 : 0o644);
    else {
      renameSync(path, path + '-retained');
      symlinkSync(path + '-retained', path);
    }
    const effects = [...t.effects];
    for (const operation of ['read', 'close'])
      await expect(executePhysicalFixture(operation, t.plan, t.runtime)).rejects.toThrow(
        /evidence|private/,
      );
    expect(t.effects).toEqual(effects);
    expect(() => acquireLease(t.plan, t.runtime.leaseRuntime)).toThrow(/reserved/);
    expect(lstatSync(path).isSymbolicLink()).toBe(change.endsWith('symlink'));
  } finally {
    t.clean();
  }
});

it('never overwrites an outside-run receipt symlink on an explicit failed read', async () => {
  const t = setup();
  t.runtime.executor.capture = () => {
    throw new Error('Dictate absent');
  };
  try {
    await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
      'Dictate absent',
    );
    const path = join(t.runtime.scratch, runID, 'receipt.json');
    const outside = join(t.directory, 'outside.json');
    renameSync(path, outside);
    symlinkSync(outside, path);
    const bytes = readFileSync(outside, 'utf8'),
      effects = [...t.effects];
    await expect(executePhysicalFixture('read', t.plan, t.runtime)).rejects.toThrow(/evidence/);
    expect(readFileSync(outside, 'utf8')).toBe(bytes);
    expect(t.effects).toEqual(effects);
  } finally {
    t.clean();
  }
});

it.each(['directory', 'file', 'dangling-symlink'])(
  'refuses a seeded run output %s collision without touching it',
  async (kind) => {
    const t = setup();
    try {
      mkdirSync(t.runtime.scratch, { mode: 0o700 });
      const path = join(t.runtime.scratch, runID);
      if (kind === 'directory') mkdirSync(path, { mode: 0o700 });
      else if (kind === 'file') writeFileSync(path, 'sentinel', { mode: 0o600 });
      else symlinkSync(join(t.directory, 'missing'), path);
      await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
        /collision/,
      );
      expect(t.effects).toEqual([]);
      if (kind === 'file') expect(readFileSync(path, 'utf8')).toBe('sentinel');
      if (kind === 'dangling-symlink') expect(lstatSync(path).isSymbolicLink()).toBe(true);
    } finally {
      t.clean();
    }
  },
);

it.each(['read', 'close'])(
  'refuses evidence owned by another UID at the public %s CLI boundary',
  async (operation) => {
    const t = setup();
    try {
      await executePhysicalFixture('capture', t.plan, t.runtime);
      const effects = [...t.effects];
      const uid = process.getuid();
      const identity = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      try {
        await expect(runPhysicalFixtureCLI([operation, '--run', runID], t.runtime)).rejects.toThrow(
          /ownership/,
        );
      } finally {
        identity.mockRestore();
      }
      expect(t.effects).toEqual(effects);
      expect(() => acquireLease(t.plan, t.runtime.leaseRuntime)).toThrow(/reserved/);
    } finally {
      t.clean();
    }
  },
);

it.each([{ port: 4 }, { output: '/other' }, { environment: { X: 'Y' } }, { unknown: true }])(
  'CLI refuses unknown capture manifest fields before executor or ownership changes %j',
  async (change) => {
    const t = setup();
    try {
      const path = join(t.directory, 'invalid.json');
      writeFileSync(path, JSON.stringify({ ...t.plan, ...change }), { mode: 0o600 });
      await expect(
        runPhysicalFixtureCLI(['capture', '--manifest', path], t.runtime),
      ).rejects.toThrow(/manifest/);
      expect(t.effects).toEqual([]);
      expect(existsSync(t.runtime.scratch)).toBe(false);
    } finally {
      t.clean();
    }
  },
);

it.each([false, true])(
  'keeps the lease through copy and post-copy validation, failed explicit read=%s',
  async (failed) => {
    const t = setup();
    if (failed)
      t.runtime.executor.capture = () => {
        throw new Error('Dictate absent');
      };
    try {
      if (failed)
        await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
          'Dictate absent',
        );
      let copied = false,
        checked = false;
      const copy = t.runtime.executor.copyArtifact,
        inspect = t.runtime.executor.inspectDevice;
      t.runtime.executor.copyArtifact = () => {
        expect(() => releaseLease(t.plan, t.runtime.leaseRuntime)).toThrow(/in use/);
        copied = true;
        return copy();
      };
      t.runtime.executor.inspectDevice = () => {
        if (copied) {
          expect(() => releaseLease(t.plan, t.runtime.leaseRuntime)).toThrow(/in use/);
          checked = true;
        }
        return inspect();
      };
      if (failed)
        await expect(executePhysicalFixture('read', t.plan, t.runtime)).rejects.toThrow(
          /remains failed/,
        );
      else
        expect((await executePhysicalFixture('capture', t.plan, t.runtime)).status).toBe(
          'captured',
        );
      expect(copied && checked).toBe(true);
    } finally {
      t.clean();
    }
  },
);

it.each(['scratch', 'lease-namespace'])(
  'refuses a %s directory alias without repairing it',
  async (kind) => {
    const t = setup();
    try {
      let path;
      if (kind === 'scratch') {
        mkdirSync(t.runtime.scratch, { mode: 0o700 });
        path = t.runtime.scratch;
      } else path = t.runtime.leaseRuntime.directory;
      renameSync(path, path + '-retained');
      symlinkSync(path + '-retained', path);
      await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
        /evidence|canonical/,
      );
      expect(t.effects).toEqual([]);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    } finally {
      t.clean();
    }
  },
);

it.each([2, 3])(
  'never installs changed shared-build bytes after device inspection %i',
  async (mutationAt) => {
    const t = setup();
    const inspect = t.runtime.executor.inspectDevice;
    let count = 0,
      current = 'verified';
    const installed = [];
    t.runtime.executor.inspectBuild = () => ({
      sourceSHA: t.plan.sourceSHA,
      sourceFingerprint: t.plan.sourceFingerprint,
      buildFingerprint: current === 'verified' ? t.plan.buildFingerprint : 'd'.repeat(64),
      bytes: current,
      provenance: { sourceSHA: t.plan.sourceSHA, sourceFingerprint: t.plan.sourceFingerprint },
    });
    t.runtime.executor.pinBuild = (_plan, build) => ({ ...build });
    t.runtime.executor.inspectDevice = () => {
      if (++count === mutationAt) current = 'changed';
      return inspect();
    };
    for (const name of ['installFixture', 'installRunner']) {
      const install = t.runtime.executor[name];
      t.runtime.executor[name] = (plan, build, output) => {
        installed.push(build.bytes);
        return install(plan, build, output);
      };
    }
    try {
      await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
        /identity differs/,
      );
      expect(installed.length).toBeGreaterThan(0);
      expect(installed.every((bytes) => bytes === 'verified')).toBe(true);
      expect(t.effects).not.toContain('capture');
    } finally {
      t.clean();
    }
  },
);

it.each(['{"runID":', JSON.stringify({ runID }), JSON.stringify({ runID, status: 'closed' })])(
  'retains ownership when close sees a partial or corrupt receipt %s',
  async (raw) => {
    const t = setup();
    try {
      await executePhysicalFixture('capture', t.plan, t.runtime);
      writeFileSync(join(t.runtime.scratch, runID, 'receipt.json'), raw);
      await expect(executePhysicalFixture('close', t.plan, t.runtime)).rejects.toThrow();
      expect(() => acquireLease(t.plan, t.runtime.leaseRuntime)).toThrow(/reserved/);
    } finally {
      t.clean();
    }
  },
);

it('refuses a target identity changed between fixture and runner installation', async () => {
  const t = setup();
  const inspect = t.runtime.executor.inspectDevice;
  let count = 0;
  t.runtime.executor.inspectDevice = () => ({
    ...inspect(),
    ...(++count === 3 ? { deviceUDID: nonce } : {}),
  });
  try {
    await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
      /device identity/,
    );
    expect(t.effects).toEqual(['install-fixture']);
    expect(() => acquireLease(t.plan, t.runtime.leaseRuntime)).toThrow(/reserved/);
  } finally {
    t.clean();
  }
});
