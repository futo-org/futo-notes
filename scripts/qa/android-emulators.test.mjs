import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  tryRun: vi.fn(),
  spawn: vi.fn(),
  assertTarget: vi.fn(),
  die: vi.fn((message) => {
    throw new Error(message);
  }),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: vi.fn() }));
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
  beforeEach(() => {
    vi.clearAllMocks();
    running = true;
    showIme = '0';
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
        running = false;
        return 'OK';
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

  it('pins the software IME and cold-boots once when a hardware keyboard disabled it', async () => {
    expect(await ensureAvd('futo-qa-0')).toBe('emulator-9998');
    const commands = mocks.tryRun.mock.calls.map(([, args]) => args.join(' '));
    expect(commands).toContain(
      '-s emulator-9998 shell settings put secure show_ime_with_hard_keyboard 1',
    );
    expect(commands).toContain('-s emulator-9998 emu kill');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
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
    expect(mocks.spawn).toHaveBeenCalledWith(
      'fake-emulator',
      ['-avd', 'futo-qa-0', '-no-snapshot-load'],
      expect.any(Object),
    );
  });

  it('fails rather than rebooting forever if the setting is lost on every boot', async () => {
    mocks.spawn.mockImplementation(() => {
      running = true;
      showIme = '0';
      return { unref: vi.fn() };
    });
    await expect(ensureAvd('futo-qa-0')).rejects.toThrow('did not persist after rebooting');
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
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
});
