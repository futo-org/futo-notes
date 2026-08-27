import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { desktopLocalization } from '$shared/localization';

import { currentToastMessage, showGlobalToast } from './toastBus.svelte';

beforeEach(() => {
  vi.useFakeTimers();
  desktopLocalization.setSelectedLanguageTag('en');
});

afterEach(() => {
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
