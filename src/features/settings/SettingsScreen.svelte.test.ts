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

import { runPuppetCommand } from '$app/puppet/puppetInspector';

import SettingsScreen from './SettingsScreen.svelte';

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

// Settings portals to <body> (the shared Modal), so queries go to `document`,
// not `target`.
function mountSettings(): void {
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
}

// Crash #1788: a vault the app cannot write to used to reach the user as a crash
// report; the toggle now says the change was not saved.
describe('SettingsScreen when a preference cannot be saved', () => {
  it('tells the user', async () => {
    savePreferences.mockResolvedValue(false);
    mountSettings();

    const dark = [...document.querySelectorAll<HTMLButtonElement>('.settings-segment')].find(
      (button) => button.textContent === 'Dark',
    );
    dark!.click();
    await vi.waitFor(() =>
      expect(showGlobalToast).toHaveBeenCalledWith({ path: 'settings.saveFailed' }),
    );
  });
});

describe('SettingsScreen dialog', () => {
  it('is named by its own heading', () => {
    mountSettings();

    const dialog = document.querySelector('[role="dialog"]')!;
    const heading = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(heading?.textContent).toBe('Settings');
  });

  // Settings registered its verbs in a modal scope of its own, outside the Modal's, so the
  // Modal hid them: `actions` offered DismissDialog and the sections' verbs, not these.
  it('offers its own verbs while it is up', () => {
    mountSettings();

    const actions = runPuppetCommand('actions', {}).body as { actions: Array<{ name: string }> };
    expect(actions.actions.map((action) => action.name)).toEqual(
      expect.arrayContaining(['CloseSettings', 'SetNotesDirectory', 'ResetNotesDirectory']),
    );
  });
});
