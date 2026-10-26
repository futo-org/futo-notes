import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  tryRun: vi.fn(),
  spawn: vi.fn(),
  assertTarget: vi.fn(),
  die: vi.fn((message) => {
    throw new Error(message);
  }),
}));
vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  spawnSync: vi.fn(),
  execFileSync: (...args) => {
    const result = mocks.tryRun(...args);
    if (result === null) throw new Error('package service unavailable');
    return result;
  },
}));
vi.mock('./android-target.mjs', () => ({ assertAndroidTarget: mocks.assertTarget }));
vi.mock('./pool.mjs', () => ({
  AVDMANAGER: 'fake-avdmanager',
  AVD_DIR: '/nonexistent-qa-fixture',
  EMULATOR: 'fake-emulator',
  IS_MAC: false,
  SDKMANAGER: 'fake-sdkmanager',
  die: mocks.die,
  info: vi.fn(),
  sleep: vi.fn(),
  tryRun: mocks.tryRun,
}));
import { ensureAvd } from './android-emulators.mjs';

describe('pooled emulator soft keyboard baseline', () => {
  let running;
  let showIme;
  let boot;
  let persist;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertTarget.mockImplementation(({ serial }) => serial);
    running = true;
    showIme = '0';
    boot = 0;
    persist = true;
    mocks.spawn.mockImplementation(() => {
      running = true;
      return { unref: vi.fn() };
    });
    mocks.tryRun.mockImplementation((command, args) => {
      const text = args.join(' ');
      if (command === 'fake-emulator' && text === '-list-avds') return 'futo-qa-0\n';
      if (command === 'adb' && text === 'devices') return running ? 'emulator-9998\tdevice\n' : '';
      if (text === '-s emulator-9998 emu avd name') return 'futo-qa-0\nOK\n';
      if (text === '-s emulator-9998 emu kill') {
        // SettingsProvider has acknowledged the put but has not flushed it.
        showIme = '0';
        running = false;
        return 'OK';
      }
      if (text.endsWith('cat /proc/sys/kernel/random/boot_id')) return `boot-${boot}`;
      if (text === '-s emulator-9998 reboot') {
        boot += 1;
        if (!persist) showIme = '0';
        return '';
      }
      if (text.includes('settings get secure show_ime_with_hard_keyboard')) return showIme;
      if (text.includes('settings put secure show_ime_with_hard_keyboard 1')) {
        showIme = '1';
        return '';
      }
      if (text.endsWith('getprop sys.boot_completed')) return '1';
      if (text.endsWith('service check package')) return 'Service package: found';
      if (text.endsWith('pm install-create')) return 'Success [17]';
      if (text.endsWith('pm install-abandon 17')) return '';
      throw new Error(`unexpected tool invocation: ${command} ${text}`);
    });
  });

  it('preserves an acknowledged but unflushed setting by rebooting Android gracefully', async () => {
    expect(await ensureAvd('futo-qa-0')).toBe('emulator-9998');
    const commands = mocks.tryRun.mock.calls.map(([, args]) => args.join(' '));
    expect(commands).toContain(
      '-s emulator-9998 shell settings put secure show_ime_with_hard_keyboard 1',
    );
    expect(commands).toContain('-s emulator-9998 reboot');
    expect(commands).not.toContain('-s emulator-9998 emu kill');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(showIme).toBe('1');
    expect(mocks.assertTarget).toHaveBeenCalled();
  });

  it('does not reboot an already-correct pooled device', async () => {
    showIme = '1';
    expect(await ensureAvd('futo-qa-0')).toBe('emulator-9998');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('preserves explicitly named legacy fixtures without changing the keyboard baseline', async () => {
    expect(await ensureAvd('futo-qa-0', { preserveConfig: true })).toBe('emulator-9998');
    expect(mocks.tryRun.mock.calls.some(([, args]) => args.includes('settings'))).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('honors an explicit Android reboot even when the keyboard baseline is already correct', async () => {
    showIme = '1';
    expect(await ensureAvd('futo-qa-0', { reboot: true })).toBe('emulator-9998');
    expect(mocks.tryRun).toHaveBeenCalledWith('adb', ['-s', 'emulator-9998', 'reboot'], {
      timeout: 5000,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('fails rather than rebooting forever if the setting is lost on every boot', async () => {
    persist = false;
    await expect(ensureAvd('futo-qa-0')).rejects.toThrow('did not persist after rebooting');
    expect(mocks.tryRun.mock.calls.filter(([, args]) => args.at(-1) === 'reboot')).toHaveLength(1);
  });

  it('fails before changing a device whose identity check is refused', async () => {
    mocks.assertTarget.mockImplementationOnce(() => {
      throw new Error('wrong owner');
    });
    await expect(ensureAvd('futo-qa-0')).rejects.toThrow('wrong owner');
    expect(
      mocks.tryRun.mock.calls.some(([, args]) => args.includes('put') || args.includes('kill')),
    ).toBe(false);
  });
  it('refuses a recycled emulator before probing its package installer', async () => {
    let ready = false;
    const run = mocks.tryRun.getMockImplementation();
    mocks.tryRun.mockImplementation((command, args, ...options) => {
      const result = run(command, args, ...options);
      if (boot > 0 && args.includes('package')) ready = true;
      return result;
    });
    mocks.assertTarget.mockImplementation(() => {
      if (ready) throw new Error('serial now belongs to another worktree');
    });
    await expect(ensureAvd('futo-qa-0')).rejects.toThrow('another worktree');
    expect(mocks.tryRun.mock.calls.some(([, args]) => args.includes('install-create'))).toBe(false);
  });
  it('also refuses a recycled serial during first-boot package readiness', async () => {
    running = false;
    mocks.assertTarget.mockImplementation(() => {
      throw new Error('wrong first-boot owner');
    });
    await expect(ensureAvd('futo-qa-0')).rejects.toThrow('wrong first-boot owner');
    expect(mocks.tryRun.mock.calls.some(([, args]) => args.includes('install-create'))).toBe(false);
  });

  it('retries a package service failure but never ignores session cleanup failure', async () => {
    running = false;
    const run = mocks.tryRun.getMockImplementation();
    let attempts = 0;
    mocks.tryRun.mockImplementation((command, args, ...options) => {
      if (args.includes('install-create') && attempts++ === 0) return null;
      if (args.includes('install-abandon')) return null;
      return run(command, args, ...options);
    });
    await expect(ensureAvd('futo-qa-0')).rejects.toThrow('package service unavailable');
    expect(attempts).toBe(2);
    expect(mocks.tryRun.mock.calls.some(([, args]) => args.includes('install-abandon'))).toBe(true);
  });

  it.each([false, true])('bounds package readiness during boot (reboot=%s)', async (reboot) => {
    running = reboot;
    // The shared boundary must permit a pending claim without losing target identity.
    await expect(ensureAvd('futo-qa-0', { reboot })).resolves.toBe('emulator-9998');
    expect(mocks.assertTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        serial: 'emulator-9998',
        expectedAvd: 'futo-qa-0',
        allowPending: true,
        execFile: expect.any(Function),
      }),
    );
    const probes = mocks.tryRun.mock.calls.filter(([, args]) => args.includes('pm'));
    expect(probes.length).toBeGreaterThan(0);
    expect(
      probes.every(([, , options]) => options.timeout === 5000 && options.killSignal === 'SIGKILL'),
    ).toBe(true);
  });
});
