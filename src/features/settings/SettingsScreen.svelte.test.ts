// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const savePreferences = vi.fn();
vi.mock('$shared/state/appState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$shared/state/appState')>()),
  savePreferences: (...args: unknown[]) => savePreferences(...args),
}));

const showGlobalToast = vi.fn();
vi.mock('$shared/notifications/toastBus.svelte', () => ({
  showGlobalToast: (...args: unknown[]) => showGlobalToast(...args),
}));

vi.mock('$features/system/theme', () => ({ applyThemePreference: vi.fn() }));

import SettingsScreen from './SettingsScreen.svelte';

// Crash #1788: a vault the app cannot write to used to reach the user as a crash
// report; the toggle now says the change was not saved.
describe('SettingsScreen when a preference cannot be saved', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target.remove();
  });

  it('tells the user', async () => {
    savePreferences.mockResolvedValue(false);
    app = mount(SettingsScreen, {
      target,
      props: {
        onclose: vi.fn(),
        backgroundSyncError: false,
        backgroundSyncErrorMessage: '',
        syncReconnecting: false,
        onsimulatesync: vi.fn(),
        onreset: vi.fn(),
      },
    });
    flushSync();

    const dark = [...target.querySelectorAll<HTMLButtonElement>('.settings-segment')].find(
      (button) => button.textContent === 'Dark',
    );
    dark!.click();
    await vi.waitFor(() =>
      expect(showGlobalToast).toHaveBeenCalledWith({ path: 'settings.saveFailed' }),
    );
  });
});
