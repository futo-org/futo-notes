import { getPlatformFS } from '$lib/platform';
import { getCachedPreferences, loadPreferences } from '$shared/state/appState';
import { initNotes } from '$features/notes/notes.svelte';
import { initSyncPassword } from '$features/sync/syncServiceE2ee';
import { applyThemePreference, watchSystemThemeTauri } from '$features/system/theme';
import { updateChecker } from '$features/system/updateChecker.svelte';

export interface AppBootstrapDeps {
  initializeCrashReporting: () => Promise<void>;
  installDevelopmentHooks: () => void | Promise<void>;
}

export interface AppBootstrap {
  readonly initialized: boolean;
  start: () => () => void;
}

// M1 render gate: `initialized` flips true synchronously as start()'s first
// statement, before any filesystem/preference/platform I/O. Every load is
// fired without awaiting ahead of the flip and applies reactively, so a cold
// sandbox where plugin-fs hangs can never blank first paint.
export function createAppBootstrap(deps: AppBootstrapDeps): AppBootstrap {
  let initialized = $state(false);

  function start(): () => void {
    initialized = true;

    let disposeThemeWatch = () => {};

    // Everything below is background work; none of it gates the render above.
    const applyCurrentTheme = () =>
      void applyThemePreference(getCachedPreferences().appearance.theme);
    applyCurrentTheme();
    disposeThemeWatch = watchSystemThemeTauri(applyCurrentTheme);
    void loadPreferences()
      .then((prefs) => applyThemePreference(prefs.appearance.theme))
      .catch((error) => console.warn('Failed to load preferences:', error));

    void getPlatformFS().catch((error) => console.warn('Platform FS unavailable:', error));
    void deps
      .initializeCrashReporting()
      .catch((error) => console.warn('Crash reporting init failed:', error));
    void updateChecker.start().catch((error) => console.warn('Update checker failed:', error));
    void initSyncPassword().catch((error) => console.warn('Sync password init failed:', error));

    void initNotes()
      .then(() => deps.installDevelopmentHooks())
      .catch((error) => console.warn('Notes init failed:', error));

    return () => {
      disposeThemeWatch();
      updateChecker.stop();
    };
  }

  return {
    get initialized() {
      return initialized;
    },
    start,
  };
}
