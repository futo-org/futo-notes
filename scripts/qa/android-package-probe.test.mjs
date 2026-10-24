import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isAndroidPackageInstalled, runPackageProbe } from './android-package-probe.mjs';

describe('Package Manager probe boundary', () => {
  it('matches the exact package rather than a filtered prefix', () => {
    const execFile = vi.fn(() => 'package:com.futo.notes.dev.extra\r\n');
    expect(
      isAndroidPackageInstalled('com.futo.notes.dev', { serial: 'fixture-phone', execFile }),
    ).toBe(false);
  });

  it('does not turn failed PM service calls into package absence', () => {
    const cause = Object.assign(new Error('service unavailable'), {
      status: 1,
      stderr: 'Cannot find service: package',
    });
    expect(() =>
      isAndroidPackageInstalled('com.futo.notes.dev', {
        serial: 'fixture-phone',
        execFile: () => {
          throw cause;
        },
      }),
    ).toThrow(/Cannot find service: package/);
  });

  it.each([
    ['install', '/fixture.apk'],
    ['clear', 'com.futo.notes.dev'],
    ['install-abandon', '42; input tap 1 1'],
  ])('refuses non-probe or unsafe PM arguments %j', (...args) => {
    const execFile = vi.fn();
    expect(() => runPackageProbe(args, { serial: 'fixture-phone', execFile })).toThrow(/probe/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('keeps install-session readiness commands bounded too', () => {
    const execFile = vi.fn(() => 'Success\n');
    for (const args of [['install-create'], ['install-abandon', '42']]) {
      expect(runPackageProbe(args, { serial: 'fixture-phone', execFile })).toBe('Success\n');
    }
    expect(execFile.mock.calls.every(([, , options]) => options.timeout === 5000)).toBe(true);
  });

  it.each([['--help'], []])('prints CLI help without accessing adb or a target: %j', (...args) => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./android-package-probe.mjs', import.meta.url)), ...args],
      {
        encoding: 'utf8',
        env: { PATH: '', ANDROID_SERIAL: '', ANDROID_AVD_NAME: '' },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('usage:');
  });
});
