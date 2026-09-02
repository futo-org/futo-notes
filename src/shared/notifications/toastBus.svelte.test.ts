// @vitest-environment jsdom
// The bus schedules its dismissal on a timer, so it needs a DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { desktopLocalization } from '$shared/localization';

import { TOAST_DURATION_MS, currentToastMessage, showGlobalToast } from './toastBus.svelte';

const vaultMissing = {
  path: 'system.notesFolderUnavailable',
  arguments: { folderPath: '/vault' },
};

beforeEach(() => {
  vi.useFakeTimers();
  desktopLocalization.setSelectedLanguageTag('en');
});

afterEach(() => {
  // Drain whatever timer the last toast left behind so the module's
  // single-slot state does not leak into the next test.
  vi.runAllTimers();
  vi.useRealTimers();
  desktopLocalization.setSelectedLanguageTag(null);
});

describe('toast localization', () => {
  it('resolves a semantic message in the current language', () => {
    showGlobalToast({ path: 'settings.language.saveFailed' });
    expect(currentToastMessage()).toBe('Language changed, but the preference could not be saved.');

    desktopLocalization.setSelectedLanguageTag('zh-Hans');
    expect(currentToastMessage()).toBe('语言已更改，但无法保存此偏好设置。');
  });
});

describe('toastBus', () => {
  // Five seconds, not three. A sync failure toast is the only warning a user
  // gets that their notes folder has gone missing (github#44), and the message
  // names a full path before telling them where to fix it — a screenshot taken
  // 3.4s after that failure caught nothing but the ⚠ indicator.
  it('holds a message for five seconds, then clears it', () => {
    showGlobalToast(vaultMissing);
    expect(currentToastMessage()).toBe(
      "Can't find your vault folder at /vault. Please reconfigure in settings.",
    );

    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(currentToastMessage()).toBe(
      "Can't find your vault folder at /vault. Please reconfigure in settings.",
    );

    vi.advanceTimersByTime(1);
    expect(currentToastMessage()).toBe('');
    expect(TOAST_DURATION_MS).toBe(5000);
  });

  // One slot: a second message replaces the first and restarts the clock, so
  // the newer message still gets its full read time rather than inheriting the
  // remainder of the older one's.
  it('a second toast replaces the first and restarts the clock', () => {
    showGlobalToast({ path: 'system.watcherUnavailable' });
    vi.advanceTimersByTime(TOAST_DURATION_MS - 500);
    showGlobalToast(vaultMissing);

    expect(currentToastMessage()).toBe(
      "Can't find your vault folder at /vault. Please reconfigure in settings.",
    );
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(currentToastMessage()).toBe(
      "Can't find your vault folder at /vault. Please reconfigure in settings.",
    );

    vi.advanceTimersByTime(1);
    expect(currentToastMessage()).toBe('');
  });
});
