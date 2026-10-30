import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireLease,
  readLease,
  releaseLease,
  useLease,
  holdLease,
  physicalFixtureHostPaths,
} from './physical-fixture-lease.mjs';

describe('physical fixture reservation', () => {
  it('uses one canonical host namespace across caller temporary-directory aliases', () => {
    const before = process.env.TMPDIR;
    try {
      process.env.TMPDIR = '/a-caller-specific-directory';
      const first = physicalFixtureHostPaths();
      process.env.TMPDIR = '/another-caller-specific-directory';
      expect(physicalFixtureHostPaths()).toEqual(first);
      expect(first.leaseDirectory).toBe(join(realpathSync('/tmp'), 'futo-physical-fixture-leases'));
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  });
  it('refuses an operator template that supplies its own unrelated owner PID', async () => {
    await expect(holdLease({ ownerPID: 123 })).rejects.toThrow(/owns its PID/);
  });
  it('reserves an exact host and hardware device without sharing or taking over a lease', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'physical-lease-test-')));
    const plan = {
      host: 'capture-host',
      deviceUDID: '00008150-001C70A634F0401C',
      coreDeviceID: '0B240C73-A6B0-49C1-B483-0DF861CE5478',
      worktree: directory,
      sourceSHA: 'a'.repeat(40),
      sourceFingerprint: 'b'.repeat(64),
      runID: '650D54CC-6339-4D62-B550-834BFBB8D7AA',
      nonce: '9ADC97CB-1A3D-443E-B5C7-62E50B90CDF1',
      ownerPID: 123,
      bundleID: 'org.futo.fixture.editor294',
      runnerBundleID: 'org.futo.fixture.editor294.uitests.xctrunner',
      seconds: 10,
      buildFingerprint: 'c'.repeat(64),
    };
    let start = 'process-start-one';
    const runtime = { directory, host: 'capture-host', processIdentity: () => start };
    try {
      const lease = acquireLease(plan, runtime);
      chmodSync(directory, 0o755);
      expect(() => readLease(plan, runtime)).toThrow(/private mode/);
      chmodSync(directory, 0o700);
      expect(readLease(plan, runtime)).toEqual(lease);
      expect(() => readLease({ ...plan, buildFingerprint: 'd'.repeat(64) }, runtime)).toThrow(
        /identity differs/,
      );
      expect(() =>
        acquireLease({ ...plan, runID: '650D54CC-6339-4D62-B550-834BFBB8D7AB' }, runtime),
      ).toThrow(/reserved/);
      start = 'recycled-pid';
      expect(() => readLease(plan, runtime)).toThrow(/owner/);
      expect(() => releaseLease(plan, runtime)).toThrow(/owner/);
      start = 'process-start-one';
      await useLease(
        plan,
        () => {
          expect(() => releaseLease(plan, runtime)).toThrow(/in use/);
          expect(() => acquireLease(plan, runtime)).toThrow(/in use/);
        },
        runtime,
      );
      releaseLease(plan, runtime);
      expect(() => readLease(plan, runtime)).toThrow();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
