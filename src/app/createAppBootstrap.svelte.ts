import { updateChecker } from '$features/system/updateChecker.svelte';
import { initSyncPassword } from '$features/sync/syncServiceE2ee';
import { getCachedPreferences, loadPreferences } from '$shared/state/appState';
import { initNotes } from '$features/notes/notes.svelte';
import { getPlatformFS, hasFileSystem } from '$lib/platform';
import { applyThemePreference, watchSystemThemeTauri } from '$features/system/theme';

interface AppBootstrapDependencies {
  initializeCrashReporting: () => Promise<void>;
  installDevelopmentHooks: () => void | Promise<void>;
}

export function createAppBootstrap({
  initializeCrashReporting,
  installDevelopmentHooks,
}: AppBootstrapDependencies) {
  let initialized = $state(false);
  let step = $state('booting');
  let stopWatchingSystemTheme: (() => void) | null = null;

  async function initializeTheme(): Promise<void> {
    const preferences = await loadPreferences();
    await applyThemePreference(preferences.appearance.theme);
    stopWatchingSystemTheme?.();
    stopWatchingSystemTheme = watchSystemThemeTauri((theme) => {
      if (getCachedPreferences().appearance.theme === 'auto') {
        void applyThemePreference('auto', theme);
      }
    });
  }

  function initializeNotes(): void {
    if (!(hasFileSystem || import.meta.env.DEV)) return;

    void initNotes((nextStep) => {
      step = nextStep;
    })
      .then(() => installDevelopmentHooks())
      .catch((error) => console.warn('initNotes failed:', error));
  }

  function start(): () => void {
    // The shell must render before any filesystem, preference, or platform I/O.
    initialized = true;

    void getPlatformFS().catch((error) => console.warn('getPlatformFS failed:', error));
    void initializeTheme().catch((error) => console.warn('Theme/prefs init failed:', error));
    // Migrate any legacy plaintext vault password into the OS keyring and
    // load the stored password without gating the first render.
    void initSyncPassword();
    initializeNotes();
    void initializeCrashReporting().catch((error) =>
      console.warn('Crash reporting init failed:', error),
    );
    void updateChecker.start().catch((error) => console.warn('Update checker init failed:', error));

    return () => {
      stopWatchingSystemTheme?.();
      stopWatchingSystemTheme = null;
      updateChecker.stop();
    };
  }

  return {
    get initialized() {
      return initialized;
    },
    get step() {
      return step;
    },
    start,
  };
}
