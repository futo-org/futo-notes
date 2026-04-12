import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { isAbsolute } from '@tauri-apps/api/path';
import {
  readTextFile,
  writeTextFile,
  readFile,
  writeFile,
  readDir,
  remove,
  mkdir,
  rename,
  exists as fsExists,
  stat,
} from '@tauri-apps/plugin-fs';
import type { DirFileEntry, FileChangeEvent, PlatformFS, NoteFile } from './types';
import { safeNotePath, safeAppdataPath } from './pathSafety';
import { writeAtomicText } from './atomicWrite';
import type { AtomicWriteFS } from './atomicWrite';
import { isNotFound } from './fsErrors';
import {
  getNotesRoot as resolveNotesRoot,
  getDefaultNotesRoot,
  loadNotesDirOverride,
  saveNotesDirOverride,
  ensureDir,
} from './tauriPaths';


export interface AppConfig {
  notesDir: string;
  sidebarWidth?: number;
  graphSidebarWidth?: number;
  isCustomDir: boolean;
  defaultNotesDir: string;
}

export interface AppConfigUpdates {
  sidebarWidth?: number | null;
  graphSidebarWidth?: number | null;
}

/** On-disk shape of .app-config.json */
interface AppConfigFile {
  sidebarWidth?: number | null;
  graphSidebarWidth?: number | null;
}

interface SupersearchRow {
  chunkId: number;
  uuid: string;
  chunkText: string;
  startOffset: number;
  endOffset: number;
  score: number;
}

// ── Cached notes root path ──────────────────────────────────────────────

let cachedNotesRoot: string | null = null;

async function getNotesRoot(): Promise<string> {
  if (cachedNotesRoot) return cachedNotesRoot;
  cachedNotesRoot = await resolveNotesRoot();
  return cachedNotesRoot;
}

/** Call when notes dir changes (e.g. user picks a new directory). */
export function invalidateNotesRootCache(): void {
  cachedNotesRoot = null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Convert a Date (or null) to Unix milliseconds, falling back to now. */
function dateToMs(d: Date | null | undefined): number {
  if (d) return d.getTime();
  return Date.now();
}

let watcherStarted = false;

async function ensureWatcherStarted(): Promise<void> {
  if (watcherStarted) return;
  await invoke('fs_start_watcher');
  watcherStarted = true;
}

function toBytes(data: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(data));
}

/** Adapter bridging @tauri-apps/plugin-fs functions to the AtomicWriteFS interface. */
const pluginFS: AtomicWriteFS = {
  writeTextFile,
  rename,
  mkdir,
  remove,
};

export const tauriFS: PlatformFS = {
  async listNoteFiles(): Promise<NoteFile[]> {
    const root = await getNotesRoot();
    const entries = await readDir(root);
    const mdEntries = entries.filter((e) => e.name?.endsWith('.md') && e.isFile);
    const noteFiles = await Promise.all(
      mdEntries.map(async (entry) => {
        const meta = await stat(`${root}/${entry.name}`);
        return { name: entry.name!, mtime: dateToMs(meta.mtime) };
      }),
    );
    noteFiles.sort((a, b) => b.mtime - a.mtime);
    return noteFiles;
  },

  async readNote(id: string): Promise<string> {
    const root = await getNotesRoot();
    return readTextFile(safeNotePath(root, id));
  },

  async writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number> {
    const root = await getNotesRoot();
    const path = safeNotePath(root, id);
    // Atomic write: write to temp file, then rename into place
    const tmpPath = `${root}/.sf-tmp-${Date.now()}`;
    await writeTextFile(tmpPath, content);
    await rename(tmpPath, path);

    // Set mtime if provided (plugin-fs cannot set mtime, use Rust command)
    if (typeof modifiedAtMs === 'number' && Number.isFinite(modifiedAtMs) && modifiedAtMs >= 0) {
      await invoke('fs_set_mtime', { path, mtimeMs: Math.trunc(modifiedAtMs) });
    }

    // Return actual mtime from disk
    const meta = await stat(path);
    return dateToMs(meta.mtime);
  },

  async deleteNoteFile(id: string): Promise<void> {
    const root = await getNotesRoot();
    try {
      await remove(safeNotePath(root, id));
    } catch (e: unknown) {
      // Swallow NotFound errors — matches Rust behavior
      if (isNotFound(e)) return;
      throw e;
    }
  },

  // Intentionally removes ALL contents under notes root — .md files, images,
  // hidden app-data files, subdirectories. This is a full reset operation.
  async deleteAllContent(): Promise<void> {
    const root = await getNotesRoot();
    const entries = await readDir(root);
    await Promise.all(
      entries
        .filter((e) => e.name)
        .map((e) => remove(`${root}/${e.name}`, { recursive: true })),
    );
  },

  async noteExists(id: string): Promise<boolean> {
    const root = await getNotesRoot();
    return fsExists(safeNotePath(root, id));
  },

  async readAppData(path: string): Promise<string | null> {
    const root = await getNotesRoot();
    const fullPath = safeAppdataPath(root, path);
    try {
      return await readTextFile(fullPath);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async writeAppData(path: string, content: string): Promise<void> {
    const root = await getNotesRoot();
    const fullPath = safeAppdataPath(root, path);
    await writeAtomicText(fullPath, content, pluginFS);
  },

  async deleteAppData(path: string): Promise<void> {
    const root = await getNotesRoot();
    const fullPath = safeAppdataPath(root, path);
    try {
      await remove(fullPath);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  },

  async listAppData(dir: string): Promise<string[]> {
    const root = await getNotesRoot();
    const fullPath = safeAppdataPath(root, dir);
    try {
      const entries = await readDir(fullPath);
      return entries.map((e) => e.name);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  },

  async readBinaryAppData(path: string): Promise<ArrayBuffer | null> {
    const root = await getNotesRoot();
    const fullPath = safeAppdataPath(root, path);
    try {
      const bytes = await readFile(fullPath);
      return bytes.buffer as ArrayBuffer;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async writeBinaryAppData(path: string, data: ArrayBuffer): Promise<void> {
    const root = await getNotesRoot();
    const fullPath = safeAppdataPath(root, path);
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });
    // Binary write is NOT atomic — matches Rust behavior
    await writeFile(fullPath, new Uint8Array(data));
  },

  async listDirFiles(): Promise<DirFileEntry[]> {
    return invoke<DirFileEntry[]>('fs_list_dir_files');
  },

  async deleteFile(filename: string): Promise<void> {
    await invoke('fs_delete_file', { filename });
  },

  async saveImage(sourcePath: string): Promise<string> {
    return invoke<string>('fs_save_image', { sourcePath });
  },

  async saveImageBytes(data: ArrayBuffer, ext: string): Promise<string> {
    return invoke<string>('fs_save_image_bytes', { data: toBytes(data), ext });
  },

  async getImageUrl(filename: string): Promise<string> {
    const absPath = await invoke<string>('fs_get_image_path', { filename });
    return convertFileSrc(absPath);
  },

  async getAppVersion(): Promise<string> {
    return getVersion();
  },

  getPlatformName(): string {
    return 'tauri';
  },

  async pickImage(): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    });
    return typeof picked === 'string' ? picked : null;
  },

  async supersearchDownload(serverUrl: string, token: string): Promise<void> {
    await invoke('supersearch_download', { serverUrl, token });
  },

  async supersearchHasArtifacts(): Promise<boolean> {
    return invoke<boolean>('supersearch_has_artifacts');
  },

  async supersearchQuery(queryVector: number[], topK: number): Promise<SupersearchRow[]> {
    return invoke<SupersearchRow[]>('supersearch_query', { queryVector, topK });
  },

  async supersearchNoteVector(uuid: string): Promise<number[]> {
    return invoke<number[]>('supersearch_note_vector', { uuid });
  },

  async supersearchAllNoteVectors(): Promise<Array<{ uuid: string; vector: number[] }>> {
    return invoke<Array<{ uuid: string; vector: number[] }>>('supersearch_all_note_vectors');
  },

};

export function onFileChange(callback: (event: FileChangeEvent) => void): () => void {
  void ensureWatcherStarted();
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void listen<FileChangeEvent>('fs:change', (event) => {
    callback(event.payload);
  }).then((fn) => {
    if (disposed) {
      fn();
      return;
    }
    unlisten = fn;
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}

export function onMenuAction(callback: (action: string) => void): () => void {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void listen<string>('menu:action', (event) => {
    callback(event.payload);
  }).then((fn) => {
    if (disposed) {
      fn();
      return;
    }
    unlisten = fn;
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}

const APP_CONFIG_PATH = '.app-config.json';

async function loadAppConfigFile(): Promise<AppConfigFile> {
  const raw = await tauriFS.readAppData(APP_CONFIG_PATH);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as AppConfigFile;
  } catch {
    return {};
  }
}

async function saveAppConfigFile(cfg: AppConfigFile): Promise<void> {
  await tauriFS.writeAppData(APP_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export async function getConfig(): Promise<AppConfig> {
  const [override, cfg, defaultNotesDir] = await Promise.all([
    loadNotesDirOverride(),
    loadAppConfigFile(),
    getDefaultNotesRoot(),
  ]);
  const notesDir = override ?? defaultNotesDir;
  await ensureDir(notesDir);
  return {
    notesDir,
    sidebarWidth: cfg.sidebarWidth ?? undefined,
    graphSidebarWidth: cfg.graphSidebarWidth ?? undefined,
    isCustomDir: override !== null,
    defaultNotesDir,
  };
}

export async function saveConfig(updates: AppConfigUpdates): Promise<void> {
  const cfg = await loadAppConfigFile();
  if ('sidebarWidth' in updates) cfg.sidebarWidth = updates.sidebarWidth;
  if ('graphSidebarWidth' in updates) cfg.graphSidebarWidth = updates.graphSidebarWidth;
  await saveAppConfigFile(cfg);
}

export async function setNotesDir(dir: string | null): Promise<void> {
  if (dir !== null) {
    if (!(await isAbsolute(dir))) {
      throw new Error('path must be absolute');
    }
    await ensureDir(dir);
  }
  await saveNotesDirOverride(dir);
  invalidateNotesRootCache();
}
