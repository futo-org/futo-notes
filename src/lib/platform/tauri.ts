import { createTauriAdapter } from './tauri/adapter';
import { createAppConfigStore } from './tauri/appConfig';

export type { AppConfig, AppConfigUpdates, PersistedTab, PersistedTabs } from './tauri/appConfig';

const adapter = createTauriAdapter();

export const tauriFS = adapter.fs;
export const invalidateNotesRootCache = adapter.invalidateNotesRoot;
export const onFileChange = adapter.onFileChange;

const appConfig = createAppConfigStore({
  storage: tauriFS,
  invalidateNotesRoot: adapter.invalidateNotesRoot,
});

export const getConfig = appConfig.getConfig;
export const saveConfig = appConfig.saveConfig;
export const loadOpenFoldersConfig = appConfig.loadOpenFoldersConfig;
export const setNotesDir = appConfig.setNotesDir;
