import { getPlatformFS, watchSystemTheme } from '$lib/platform';
import { recordPerfEvent } from '$shared/perf/perfEvents';
import { desktopLocalization } from '$shared/localization';
import type { ToastMessage } from '$shared/notifications/toastBus.svelte';
import {
  getCachedPreferences,
  loadPreferences,
  saveSelectedLanguageTag,
} from '$shared/state/appState';
import { initNotes } from '$features/notes/notes.svelte';
import { initSyncPassword } from '$features/sync/syncServiceE2ee';
import { applyThemePreference, type ResolvedTheme } from '$features/system/theme';
import { updateChecker } from '$features/system/updateChecker.svelte';

export interface AppBootstrapDeps {
  initializeCrashReporting: () => Promise<void>;
  installDevelopmentHooks: () => void | Promise<void>;
  showToast: (message: ToastMessage) => void;
}

export interface AppBootstrap {
  readonly initialized: boolean;
  readonly themeApplied: boolean;
  start: () => () => void;
}

function watchDesktopSystemLanguage(): () => void {
  if (typeof window === 'undefined') return () => {};
  const refreshLanguage = () => desktopLocalization.refreshSystemLanguage();
  window.addEventListener('focus', refreshLanguage);
  return () => window.removeEventListener('focus', refreshLanguage);
}

// M1 render gate: `initialized` flips true synchronously as start()'s first
// statement, before any filesystem/preference/platform I/O. Every load is
// fired without awaiting ahead of the flip and applies reactively, so a cold
// sandbox where plugin-fs hangs can never blank first paint.
export function createAppBootstrap(deps: AppBootstrapDeps): AppBootstrap {
  let initialized = $state(false);
  let themeApplied = $state(false);

  function start(): () => void {
    initialized = true;

    const disposeLanguageWatch = watchDesktopSystemLanguage();
    const initialLanguageSelectionRevision = desktopLocalization.selectionRevision;

    // Everything below is background work; none of it gates the render above.
    // Forward the OS-reported theme: on Linux the webview's matchMedia can't see
    // the desktop theme, so the portal event's value must win for `auto`.
    const applyCurrentTheme = (systemTheme?: ResolvedTheme) =>
      applyThemePreference(getCachedPreferences().appearance.theme, systemTheme);
    void applyCurrentTheme();
    const disposeThemeWatch = watchSystemTheme(
      (systemTheme) => void applyCurrentTheme(systemTheme),
    );

    void initNotes((label) => {
      const elapsed = performance.now();
      recordPerfEvent(`startup:${label}`, elapsed);
      if (label === 'initNotes: listing projected') {
        recordPerfEvent('startup:notes-loaded', elapsed);
      }
    })
      .then(() => {
        return deps.installDevelopmentHooks();
      })
      .catch((error) => console.warn('Notes init failed:', error));

    // Let the latency-sensitive notes invoke enter Tauri's queue first. These
    // independent services still begin in the same event-loop turn and never
    // depend on notes succeeding.
    queueMicrotask(() => {
      void loadPreferences()
        .then(async (preferences) => {
          const themeApplication = applyThemePreference(preferences.appearance.theme);
          if (desktopLocalization.selectionRevision === initialLanguageSelectionRevision) {
            const storedLanguageTag = preferences.language.selectedLanguageTag;
            const selectedLanguageTag =
              desktopLocalization.setSelectedLanguageTag(storedLanguageTag);
            if (selectedLanguageTag !== storedLanguageTag) {
              try {
                await saveSelectedLanguageTag(selectedLanguageTag);
              } catch {
                deps.showToast({ path: 'settings.language.saveFailed' });
              }
            }
          }
          await themeApplication;
        })
        .catch((error) => console.warn('Failed to load preferences:', error))
        // The stored preference is now applied (or cannot be): App.svelte may
        // reveal the window without painting the default theme first.
        .finally(() => (themeApplied = true));
      void getPlatformFS().catch((error) => console.warn('Platform FS unavailable:', error));
      void deps
        .initializeCrashReporting()
        .catch((error) => console.warn('Crash reporting init failed:', error));
      void updateChecker.start().catch((error) => console.warn('Update checker failed:', error));
      void initSyncPassword().catch((error) => console.warn('Sync password init failed:', error));
    });

    return () => {
      disposeThemeWatch();
      disposeLanguageWatch();
      updateChecker.stop();
    };
  }

  return {
    get initialized() {
      return initialized;
    },
    get themeApplied() {
      return themeApplied;
    },
    start,
  };
}
