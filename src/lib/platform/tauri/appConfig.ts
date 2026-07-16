import { isAbsolute } from '@tauri-apps/api/path';

import type { PlatformFS } from '../types';
import {
  ensureDirectory,
  loadNotesDirOverride,
  resolveDefaultNotesRoot,
  saveNotesDirOverride,
} from './notesRoot';

export interface PersistedTab {
  id: string;
  noteId: string | null;
  pendingFolder?: string;
  state?: { scroll: number };
}

export interface PersistedTabs {
  tabs: PersistedTab[];
  activeTabId: string | null;
}

export interface AppConfig {
  notesDir: string;
  sidebarWidth?: number;
  openTabs?: PersistedTabs;
  isCustomDir: boolean;
  defaultNotesDir: string;
}

export interface AppConfigUpdates {
  sidebarWidth?: number | null;
  openFolders?: string[] | null;
  openTabs?: PersistedTabs | null;
}

interface AppConfigFile {
  sidebarWidth?: number | null;
  openFolders?: string[] | null;
  openTabs?: PersistedTabs | null;
}

interface AppConfigDependencies {
  storage: Pick<PlatformFS, 'readAppData' | 'writeAppData'>;
  invalidateNotesRoot: () => void;
}

const APP_CONFIG_PATH = '.app-config.json';

export function createAppConfigStore({ storage, invalidateNotesRoot }: AppConfigDependencies) {
  async function readConfig(fallbackOnError = true): Promise<AppConfigFile> {
    try {
      const raw = await storage.readAppData(APP_CONFIG_PATH);
      if (!raw) return {};
      try {
        return JSON.parse(raw) as AppConfigFile;
      } catch {
        return {};
      }
    } catch (error) {
      if (!fallbackOnError) throw error;
      console.warn(`Failed to read ${APP_CONFIG_PATH}, using defaults:`, error);
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
      resolveDefaultNotesRoot(),
    ]);
    const notesDir = override ?? defaultNotesDir;
    await ensureDirectory(notesDir);
    return {
      notesDir,
      sidebarWidth: config.sidebarWidth ?? undefined,
      openTabs: config.openTabs ?? undefined,
      isCustomDir: override !== null,
      defaultNotesDir,
    };
  }

  async function saveConfig(updates: AppConfigUpdates): Promise<void> {
    const config = await readConfig(false);
    if ('sidebarWidth' in updates) config.sidebarWidth = updates.sidebarWidth;
    if ('openFolders' in updates) config.openFolders = updates.openFolders;
    if ('openTabs' in updates) config.openTabs = updates.openTabs;
    await writeConfig(config);
  }

  async function loadOpenFoldersConfig(): Promise<string[] | null> {
    const folders = (await readConfig()).openFolders;
    if (!Array.isArray(folders)) return null;
    return folders.filter((path): path is string => typeof path === 'string');
  }

  async function setNotesDir(path: string | null): Promise<void> {
    if (path !== null) {
      if (!(await isAbsolute(path))) throw new Error('path must be absolute');
      await ensureDirectory(path);
    }
    await saveNotesDirOverride(path);
    invalidateNotesRoot();
  }

  return { getConfig, saveConfig, loadOpenFoldersConfig, setNotesDir };
}
