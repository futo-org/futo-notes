// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type { AppPreferences } from '$shared/state/appState';

// M1 render gate: every dependency hangs forever so the test proves the shell
// gate cannot be waiting on any of them. (Factories are hoisted, so the
// never-resolving promise is inlined per mock.)
vi.mock('$features/system/updateChecker.svelte', () => ({
  updateChecker: { start: vi.fn(() => new Promise(() => {})), stop: vi.fn() },
}));
vi.mock('$features/sync/syncServiceE2ee', () => ({
  initSyncPassword: vi.fn(() => new Promise(() => {})),
}));
const preferenceMocks = vi.hoisted(() => ({
  loadPreferences: vi.fn(() => new Promise(() => {})),
  saveSelectedLanguageTag: vi.fn(() => Promise.resolve()),
}));
vi.mock('$shared/state/appState', () => ({
  loadPreferences: preferenceMocks.loadPreferences,
  saveSelectedLanguageTag: preferenceMocks.saveSelectedLanguageTag,
  getCachedPreferences: vi.fn(() => ({
    appearance: { theme: 'auto' },
    language: { selectedLanguageTag: null },
  })),
}));
vi.mock('$features/notes/notes.svelte', () => ({
  initNotes: vi.fn(() => new Promise(() => {})),
}));
const themeMocks = vi.hoisted(() => {
  let capturedOnChange: ((theme?: string) => void) | undefined;
  return {
    applyThemePreference: vi.fn(() => Promise.resolve('light')),
    watchSystemTheme: vi.fn((onChange: (theme?: string) => void) => {
      capturedOnChange = onChange;
      return () => {};
    }),
    fireSystemThemeChange: (theme?: string) => capturedOnChange?.(theme),
  };
});
vi.mock('$lib/platform', () => ({
  getPlatformFS: vi.fn(() => new Promise(() => {})),
  hasFileSystem: true,
  watchSystemTheme: themeMocks.watchSystemTheme,
}));
vi.mock('$features/system/theme', () => ({
  applyThemePreference: themeMocks.applyThemePreference,
}));

import { desktopLocalization } from '$shared/localization';
import { createAppBootstrap } from './createAppBootstrap.svelte';

const never = () => new Promise<never>(() => {});
const storedPreferences = (
  theme: AppPreferences['appearance']['theme'],
  selectedLanguageTag: string | null,
): AppPreferences => ({
  appearance: { theme },
  language: { selectedLanguageTag },
  crashReporting: { enabled: true, alwaysSend: false },
  updates: { enabled: true },
  sync: { serverUrl: '', token: '', lastSyncedAt: null, lastError: '' },
});

describe('createAppBootstrap (M1 render gate)', () => {
  it('flips initialized synchronously even when every init call never resolves', () => {
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: vi.fn(never),
      installDevelopmentHooks: vi.fn(),
      showToast: vi.fn(),
    });

    expect(bootstrap.initialized).toBe(false);
    const stop = bootstrap.start();
    // Asserted synchronously — no awaits, no timers. If start() ever awaits
    // filesystem/preference/platform I/O before flipping the gate, this reads
    // false and the shell would render nothing until that I/O completed (M1).
    expect(bootstrap.initialized).toBe(true);
    stop();
  });

  it('keeps the render gate up when an init step rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: vi.fn(() => Promise.reject(new Error('collector down'))),
      installDevelopmentHooks: vi.fn(),
      showToast: vi.fn(),
    });

    const stop = bootstrap.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(bootstrap.initialized).toBe(true);
    stop();
    warn.mockRestore();
  });

  it('forwards the OS-reported theme so auto follows the desktop theme on Linux', () => {
    // getCachedPreferences() is mocked to an Auto appearance preference.
    themeMocks.applyThemePreference.mockClear();
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: vi.fn(never),
      installDevelopmentHooks: vi.fn(),
      showToast: vi.fn(),
    });

    const stop = bootstrap.start();
    // Initial apply has no OS value to forward.
    expect(themeMocks.applyThemePreference).toHaveBeenNthCalledWith(1, 'auto', undefined);

    // Portal/Tauri theme-change event carries the resolved theme; on Linux the
    // webview's matchMedia can't see it, so this override must reach applyThemePreference.
    themeMocks.fireSystemThemeChange('dark');
    expect(themeMocks.applyThemePreference).toHaveBeenLastCalledWith('auto', 'dark');

    stop();
  });

  it('reports the theme applied only once the stored preference is applied, so the reveal can wait', async () => {
    let resolvePreferences = (_preferences: AppPreferences) => {};
    preferenceMocks.loadPreferences.mockImplementationOnce(
      () => new Promise<AppPreferences>((resolve) => (resolvePreferences = resolve)),
    );
    let resolveApply = (_theme: string) => {};
    themeMocks.applyThemePreference
      .mockImplementationOnce(() => Promise.resolve('light'))
      .mockImplementationOnce(() => new Promise<string>((resolve) => (resolveApply = resolve)));
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: vi.fn(never),
      installDevelopmentHooks: vi.fn(),
      showToast: vi.fn(),
    });

    const stop = bootstrap.start();
    expect(bootstrap.initialized).toBe(true);
    await vi.waitFor(() => expect(preferenceMocks.loadPreferences).toHaveBeenCalled());
    // The cached-default apply settled; the stored preference has not landed.
    expect(bootstrap.themeApplied).toBe(false);

    resolvePreferences(storedPreferences('dark', null));
    await vi.waitFor(() =>
      expect(themeMocks.applyThemePreference).toHaveBeenLastCalledWith('dark'),
    );
    expect(bootstrap.themeApplied).toBe(false);

    resolveApply('dark');
    await vi.waitFor(() => expect(bootstrap.themeApplied).toBe(true));
    stop();
  });

  it('still reveals when preferences cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    preferenceMocks.loadPreferences.mockRejectedValueOnce(new Error('disk unavailable'));
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: vi.fn(never),
      installDevelopmentHooks: vi.fn(),
      showToast: vi.fn(),
    });

    const stop = bootstrap.start();
    await vi.waitFor(() => expect(bootstrap.themeApplied).toBe(true));
    stop();
    warn.mockRestore();
  });

  it('refreshes System language when the window returns to the foreground', () => {
    const refreshSystemLanguage = vi.spyOn(desktopLocalization, 'refreshSystemLanguage');
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: vi.fn(never),
      installDevelopmentHooks: vi.fn(),
      showToast: vi.fn(),
    });

    const stop = bootstrap.start();
    window.dispatchEvent(new Event('focus'));
    expect(refreshSystemLanguage).toHaveBeenCalledOnce();

    stop();
    window.dispatchEvent(new Event('focus'));
    expect(refreshSystemLanguage).toHaveBeenCalledOnce();
    refreshSystemLanguage.mockRestore();
  });

  it('does not replace a language selected while preferences are loading', async () => {
    let resolvePreferences = (_preferences: AppPreferences) => {};
    preferenceMocks.loadPreferences.mockImplementationOnce(
      () =>
        new Promise<AppPreferences>((resolve) => {
          resolvePreferences = resolve;
        }),
    );
    preferenceMocks.saveSelectedLanguageTag.mockClear();
    desktopLocalization.setSelectedLanguageTag(null);
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: vi.fn(never),
      installDevelopmentHooks: vi.fn(),
      showToast: vi.fn(),
    });

    const stop = bootstrap.start();
    await vi.waitFor(() => expect(preferenceMocks.loadPreferences).toHaveBeenCalled());
    desktopLocalization.setSelectedLanguageTag('zh-Hans');
    resolvePreferences(storedPreferences('auto', 'en'));
    await Promise.resolve();
    await Promise.resolve();

    expect(desktopLocalization.selectedLanguageTag).toBe('zh-Hans');
    expect(desktopLocalization.effectiveLanguage.tag).toBe('zh-Hans');
    expect(preferenceMocks.saveSelectedLanguageTag).not.toHaveBeenCalled();

    stop();
    desktopLocalization.setSelectedLanguageTag(null);
  });

  it('corrects an unavailable stored language to System and reports save failure', async () => {
    preferenceMocks.loadPreferences.mockResolvedValueOnce(storedPreferences('auto', 'fr'));
    preferenceMocks.saveSelectedLanguageTag.mockRejectedValueOnce(new Error('disk unavailable'));
    const showToast = vi.fn();
    const bootstrap = createAppBootstrap({
      initializeCrashReporting: vi.fn(never),
      installDevelopmentHooks: vi.fn(),
      showToast,
    });

    const stop = bootstrap.start();

    await vi.waitFor(() => {
      expect(preferenceMocks.saveSelectedLanguageTag).toHaveBeenCalledWith(null);
      expect(showToast).toHaveBeenCalledWith({ path: 'settings.language.saveFailed' });
    });

    stop();
  });
});
