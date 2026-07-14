import { isAbsolute } from '@tauri-apps/api/path';

import type { PlatformFS } from '../types';
import {
  ensureDir,
  getDefaultNotesRoot,
  loadNotesDirOverride,
  saveNotesDirOverride,
} from '../tauriPaths';

export interface PersistedTab {
  id: string;
  noteId: string | null;
  pendingFolder?: string;
  state?: { scroll: number; selFrom: number; selTo: number };
}

export interface PersistedTabs {
  tabs: PersistedTab[];
  activeTabId: string | null;
}

export interface AppConfig {
  notesDir: string;
  sidebarWidth?: number;
  graphSidebarWidth?: number;
  openTabs?: PersistedTabs;
  isCustomDir: boolean;
  defaultNotesDir: string;
}

export interface AppConfigUpdates {
  sidebarWidth?: number | null;
  graphSidebarWidth?: number | null;
  openFolders?: string[] | null;
  openTabs?: PersistedTabs | null;
}

interface AppConfigFile {
  sidebarWidth?: number | null;
  graphSidebarWidth?: number | null;
  openFolders?: string[] | null;
  openTabs?: PersistedTabs | null;
}

interface AppConfigDependencies {
  storage: Pick<PlatformFS, 'readAppData' | 'writeAppData'>;
  invalidateNotesRoot: () => void;
}

const APP_CONFIG_PATH = '.app-config.json';

export function createAppConfigStore({ storage, invalidateNotesRoot }: AppConfigDependencies) {
  async function readConfig(fallbackOnReadError = true): Promise<AppConfigFile> {
    let raw: string | null;
    try {
      raw = await storage.readAppData(APP_CONFIG_PATH);
    } catch (error) {
      if (!fallbackOnReadError) throw error;
      console.warn(`Failed to read ${APP_CONFIG_PATH}, using defaults:`, error);
      return {};
    }

    if (!raw) return {};
    try {
      return JSON.parse(raw) as AppConfigFile;
    } catch {
      return {};
    }
  }

  async function writeConfig(config: AppConfigFile): Promise<void> {
    await storage.writeAppData(APP_CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  async function getConfig(): Promise<AppConfig> {
    const [override, config, defaultNotesDir] = await Promise.all([
      loadNotesDirOverride(),
      readConfig(),
      getDefaultNotesRoot(),
    ]);
    const notesDir = override ?? defaultNotesDir;
    await ensureDir(notesDir);
    return {
      notesDir,
      sidebarWidth: config.sidebarWidth ?? undefined,
      graphSidebarWidth: config.graphSidebarWidth ?? undefined,
      openTabs: config.openTabs ?? undefined,
      isCustomDir: override !== null,
      defaultNotesDir,
    };
  }

  async function saveConfig(updates: AppConfigUpdates): Promise<void> {
    const config = await readConfig(false);
    if ('sidebarWidth' in updates) config.sidebarWidth = updates.sidebarWidth;
    if ('graphSidebarWidth' in updates) config.graphSidebarWidth = updates.graphSidebarWidth;
    if ('openFolders' in updates) config.openFolders = updates.openFolders;
    if ('openTabs' in updates) config.openTabs = updates.openTabs;
    await writeConfig(config);
  }

  async function loadOpenFoldersConfig(): Promise<string[] | null> {
    const config = await readConfig();
    if (!Array.isArray(config.openFolders)) return null;
    return config.openFolders.filter((path): path is string => typeof path === 'string');
  }

  async function setNotesDir(path: string | null): Promise<void> {
    if (path !== null) {
      if (!(await isAbsolute(path))) throw new Error('path must be absolute');
      await ensureDir(path);
    }
    await saveNotesDirOverride(path);
    invalidateNotesRoot();
  }

  return { getConfig, saveConfig, loadOpenFoldersConfig, setNotesDir };
}
