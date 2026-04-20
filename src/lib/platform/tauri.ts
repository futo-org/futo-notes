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
import { isMobile } from './index';
import { generateImageFilename, isImageFilename } from '$lib/images';
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
let assetProtocolWorks: boolean | null = null;

async function ensureWatcherStarted(): Promise<void> {
  if (watcherStarted) return;
  // Mobile: app is the sole writer; kqueue rescan on every appdata write
  // (.engagement / .app-state live in the notes dir) pinned a tokio worker.
  if (isMobile) {
    watcherStarted = true;
    return;
  }
  await invoke('fs_start_watcher');
  watcherStarted = true;
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
    // Single IPC hop: the Rust side does one `read_dir + metadata` pass
    // and returns [{name, mtimeMs, sizeBytes}] sorted desc. Collapses what
    // used to be 1 + 2N round-trips (readDir + N stat) into one — on iOS
    // with 2000 notes this drops startup wall time by ~1s per call. Size
    // is used by sync to skip unchanged files without reading them.
    const entries = await invoke<Array<{ name: string; mtimeMs: number; sizeBytes: number }>>(
      'fs_list_notes_with_meta',
    );
    return entries.map((e) => ({ name: e.name, mtime: e.mtimeMs, size: e.sizeBytes }));
  },

  async readNote(id: string): Promise<string> {
    const root = await getNotesRoot();
    return readTextFile(safeNotePath(root, id));
  },

  async writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number> {
    // Single IPC: Rust does the atomic write (temp + rename), optional
    // mtime override, and mtime read-back in one blocking call. Replaces
    // the plugin-fs writeTextFile + rename + fs_set_mtime + stat chain —
    // on iOS that was four separate round-trips per save-debounce tick
    // and noticeably stole main-thread time while typing.
    const modifiedAt =
      typeof modifiedAtMs === 'number' && Number.isFinite(modifiedAtMs) && modifiedAtMs >= 0
        ? Math.trunc(modifiedAtMs)
        : null;
    return await invoke<number>('fs_write_note_atomic', {
      id,
      content,
      modifiedAtMs: modifiedAt,
    });
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
    const root = await getNotesRoot();
    const entries = await readDir(root);
    const fileEntries = entries.filter((e) => e.isFile && e.name);
    const results = await Promise.all(
      fileEntries.map(async (entry) => {
        try {
          const meta = await stat(`${root}/${entry.name}`);
          return {
            name: entry.name!,
            size: meta.size,
            mtime: dateToMs(meta.mtime),
          } as DirFileEntry;
        } catch {
          // Skip unreadable entries (e.g. broken symlinks) — matches the
          // Rust `filter_map(|entry| entry.ok())` behavior.
          return null;
        }
      }),
    );
    return results.filter((e): e is DirFileEntry => e !== null);
  },

  async deleteFile(filename: string): Promise<void> {
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error('invalid filename');
    }
    const root = await getNotesRoot();
    await remove(`${root}/${filename}`);
  },

  async saveImage(sourcePath: string): Promise<string> {
    return invoke<string>('fs_save_image', { sourcePath });
  },

  async saveImageBytes(data: ArrayBuffer, ext: string): Promise<string> {
    const filename = generateImageFilename(ext);
    const root = await getNotesRoot();
    await writeFile(`${root}/${filename}`, new Uint8Array(data));
    return filename;
  },

  async getImageUrl(filename: string): Promise<string> {
    if (!isImageFilename(filename)) {
      throw new Error('not an image filename');
    }
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error('invalid filename');
    }
    const root = await getNotesRoot();
    const assetUrl = convertFileSrc(`${root}/${filename}`);
    // Tauri v2's asset protocol can reject paths even when fs:scope covers
    // them. Probe once per session — if the asset protocol works, use it for
    // every image (zero-copy); otherwise fall back to blob URLs.
    if (assetProtocolWorks === null) {
      try {
        const probe = await fetch(assetUrl, { method: 'HEAD' });
        assetProtocolWorks = probe.ok;
      } catch {
        assetProtocolWorks = false;
      }
    }
    if (assetProtocolWorks) return assetUrl;

    const bytes = await readFile(`${root}/${filename}`);
    const ext = filename.split('.').pop()?.toLowerCase() ?? 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : 'image/png';
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
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
