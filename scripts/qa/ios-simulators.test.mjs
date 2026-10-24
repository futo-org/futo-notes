import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tryRun } = vi.hoisted(() => ({ tryRun: vi.fn() }));
vi.mock('./pool.mjs', () => ({
  SIM_DEVICE_TYPE: 'test-device',
  die: vi.fn(),
  info: vi.fn(),
  run: vi.fn(),
  sleep: vi.fn(),
  tryRun,
}));
import { wipeDevApp } from './ios-simulators.mjs';

describe('iOS pool handoff wipe', () => {
  beforeEach(() => tryRun.mockReset());

  it('uninstalls the dev app container (including defaults) and resets the persistent keychain', () => {
    tryRun.mockReturnValue('');
    expect(wipeDevApp('claimed-udid')).toBeNull();
    expect(tryRun.mock.calls.map(([, args]) => args)).toEqual([
      ['simctl', 'get_app_container', 'claimed-udid', 'com.futo.notes.dev'],
      ['simctl', 'uninstall', 'claimed-udid', 'com.futo.notes.dev'],
      ['simctl', 'keychain', 'claimed-udid', 'reset'],
    ]);
  });

  it('fails the handoff if uninstall cannot clear the previous holder defaults', () => {
    tryRun.mockReturnValueOnce('/container').mockReturnValueOnce(null);
    expect(wipeDevApp('claimed-udid')).toContain('uninstall');
  });

  it('resets the keychain even when no app is installed', () => {
    tryRun.mockReturnValueOnce(null).mockReturnValueOnce('');
    expect(wipeDevApp('claimed-udid')).toBeNull();
    expect(tryRun).toHaveBeenCalledTimes(2);
    expect(tryRun.mock.lastCall[1]).toEqual(['simctl', 'keychain', 'claimed-udid', 'reset']);
  });

  it('fails the handoff when the keychain reset fails', () => {
    tryRun.mockReturnValueOnce(null).mockReturnValueOnce(null);
    expect(wipeDevApp('claimed-udid')).toContain('keychain reset failed');
  });
});
