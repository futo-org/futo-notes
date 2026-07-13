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
import type { DirFileEntry, FileChangeEvent, PlatformFS } from './types';
import { IMAGE_EXTENSIONS } from '@futo-notes/shared';
import { safeAppdataPath } from './pathSafety';
import { writeAtomicText } from './atomicWrite';
import type { AtomicWriteFS } from './atomicWrite';
import { isNotFound } from './fsErrors';
import { generateImageFilename, isImageFilename } from '$lib/images';
import {
  getNotesRoot as resolveNotesRoot,
  getDefaultNotesRoot,
  loadNotesDirOverride,
  saveNotesDirOverride,
  ensureDir,
} from './tauriPaths';

export interface PersistedTab {
  id: string;
  noteId: string | null;
  pendingFolder?: string;
  // Per-tab scroll/selection, persisted so it survives a restart (tabs.md).
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
  /** Snapshot of which folder paths are expanded in the sidebar
   *  tree. Persisted here (in addition to localStorage) so the state
   *  survives iOS WKWebView storage purges and Android WebView resets. */
  openFolders?: string[] | null;
  /** Desktop-only: serialized state of the tab strip. */
  openTabs?: PersistedTabs | null;
}

/** On-disk shape of .app-config.json */
interface AppConfigFile {
  sidebarWidth?: number | null;
  graphSidebarWidth?: number | null;
  openFolders?: string[] | null;
  openTabs?: PersistedTabs | null;
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

/**
 * Race a promise against a timeout. iOS plugin-fs (`readTextFile`, `exists`)
 * has been observed to hang indefinitely on certain paths instead of
 * returning or rejecting — this wraps the call so background loaders can
 * recover with a sentinel instead of stalling the app forever.
 */
function withTimeout<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const FS_READ_TIMEOUT_MS = 8_000;

/**
 * Walk up from `dir` removing empty directories until reaching `root`
 * or a non-empty directory. Best-effort: any error stops the walk and
 * is swallowed because folder pruning is purely a cosmetic cleanup.
 */
let watcherStarted = false;
let assetProtocolWorks: boolean | null = null;

/**
 * Maps a lowercase image file extension to its blob Content-Type. Covers the
 * full accepted set (see IMAGE_EXTENSIONS in @futo-notes/shared). The MIME is
 * load-bearing for blob URLs: a wrong type (e.g. SVG served as image/png) is
 * not content-sniffed and fails to render. Unknown extensions fall back to
 * image/png.
 */
const IMAGE_EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  heic: 'image/heic',
};

/** Blob Content-Type for an image file extension (lowercased), defaulting to image/png. */
export function imageMimeForExtension(ext: string): string {
  return IMAGE_EXTENSION_MIME[ext.toLowerCase()] ?? 'image/png';
}

/**
 * Does an <img> actually DECODE this URL? A HEAD/GET 200 from the asset
 * protocol does NOT guarantee the webview will paint it — macOS WKWebView and
 * Linux WebKitGTK can answer an asset:// request while an <img> renders a blank
 * (pure-white) box at the reserved size. So probe the one thing that matters: a
 * real image decode. Resolves false on any failure — including environments
 * with no Image constructor — so callers fall back to the reliable blob path
 * when in doubt.
 */
async function assetUrlDecodes(url: string): Promise<boolean> {
  if (typeof Image !== 'function') return false;
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('asset decode failed'));
      img.src = url;
    });
    return img.naturalWidth > 0;
  } catch {
    return false;
  }
}

async function ensureWatcherStarted(): Promise<void> {
  if (watcherStarted) return;
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
  async readAppData(path: string): Promise<string | null> {
    const root = await getNotesRoot();
    const fullPath = safeAppdataPath(root, path);
    // iOS plugin-fs has been observed to hang on both readTextFile and
    // (rarely) exists() — the timeout below is a hard backstop so a
    // single bad read can't trap the app on the loading screen forever.
    try {
      const present = await withTimeout(`exists(${path})`, FS_READ_TIMEOUT_MS, fsExists(fullPath));
      if (!present) return null;
      return await withTimeout(`readAppData(${path})`, FS_READ_TIMEOUT_MS, readTextFile(fullPath));
    } catch (err) {
      if (isNotFound(err)) return null;
      // Surface the error to callers so they can fall back to defaults
      // rather than caching a partial result.
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
    if (!(await fsExists(fullPath))) return null;
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
    // every image (zero-copy); otherwise fall back to blob URLs. The probe must
    // verify an <img> actually DECODES the URL (a HEAD/GET 200 from the custom
    // scheme is not enough: WKWebView/WebKitGTK answer the request but paint a
    // blank white box), so an undecodable asset URL falls back to the blob path.
    if (assetProtocolWorks === null) {
      assetProtocolWorks = await assetUrlDecodes(assetUrl);
    }
    if (assetProtocolWorks) return assetUrl;

    const bytes = await readFile(`${root}/${filename}`);
    const ext = filename.split('.').pop()?.toLowerCase() ?? 'png';
    const mime = imageMimeForExtension(ext);
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
      filters: [{ name: 'Images', extensions: [...IMAGE_EXTENSIONS] }],
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
    if (disposed) return;
    disposed = true;
    const fn = unlisten;
    unlisten = null;
    fn?.();
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
    if (disposed) return;
    disposed = true;
    const fn = unlisten;
    unlisten = null;
    fn?.();
  };
}

const APP_CONFIG_PATH = '.app-config.json';

async function loadAppConfigFile(
  options: { fallbackOnReadError?: boolean } = {},
): Promise<AppConfigFile> {
  const fallbackOnReadError = options.fallbackOnReadError ?? true;
  let raw: string | null;
  try {
    raw = await tauriFS.readAppData(APP_CONFIG_PATH);
  } catch (err) {
    // On macOS a TCC/permission denial makes the open reject EPERM. Degrade to
    // defaults for read-only startup paths so settings still load. Save paths
    // must remain strict, though: read-modify-write after a failed read would
    // clobber unrelated persisted fields.
    if (!fallbackOnReadError) throw err;
    console.warn(`Failed to read ${APP_CONFIG_PATH}, using defaults:`, err);
    return {};
  }
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
    openTabs: cfg.openTabs ?? undefined,
    isCustomDir: override !== null,
    defaultNotesDir,
  };
}

export async function saveConfig(updates: AppConfigUpdates): Promise<void> {
  const cfg = await loadAppConfigFile({ fallbackOnReadError: false });
  if ('sidebarWidth' in updates) cfg.sidebarWidth = updates.sidebarWidth;
  if ('graphSidebarWidth' in updates) cfg.graphSidebarWidth = updates.graphSidebarWidth;
  if ('openFolders' in updates) cfg.openFolders = updates.openFolders;
  if ('openTabs' in updates) cfg.openTabs = updates.openTabs;
  await saveAppConfigFile(cfg);
}

/** Read just the persisted set of expanded folder paths. Returns null
 *  when the config file has no entry, so callers can distinguish
 *  "never persisted" from "persisted as empty list". */
export async function loadOpenFoldersConfig(): Promise<string[] | null> {
  const cfg = await loadAppConfigFile();
  if (!Array.isArray(cfg.openFolders)) return null;
  return cfg.openFolders.filter((s): s is string => typeof s === 'string');
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
