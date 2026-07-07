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
import type { DirFileEntry, FileChangeEvent, PlatformFS, NoteFile, FolderEntry, NotePreviewMeta } from './types';
import { noteParentDir, safeAppdataPath } from './pathSafety';
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
async function pruneEmptyAncestors(root: string, dir: string): Promise<void> {
  if (dir === root) return;
  let cursor = dir;
  // Cap iterations defensively — the depth limit is enforced elsewhere.
  for (let i = 0; i < 16; i++) {
    if (!cursor.startsWith(root) || cursor === root) return;
    try {
      const entries = await readDir(cursor);
      if (entries.length > 0) return;
      await remove(cursor);
    } catch {
      return;
    }
    const slash = cursor.lastIndexOf('/');
    if (slash <= root.length) return;
    cursor = cursor.slice(0, slash);
  }
}

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
  // Mobile: app is the sole writer; kqueue rescan on every appdata write
  // (.app-state lives in the notes dir) pinned a tokio worker.
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

  async scanNotes(): Promise<NotePreviewMeta[]> {
    // One IPC: Rust scans the whole vault (read_dir + read + preview + tags),
    // sorted mtime-desc, via futo-notes-model::scan_notes. The command does
    // notes_root() → create_dir_all itself, so no ensureNotesFolder() /
    // getPlatformFS() await is needed in front — eliminating the iOS
    // cold-sandbox plugin-fs hang class on the note path.
    const metas = await invoke<
      Array<{ id: string; title: string; folder: string; modifiedMs: number; preview: string; tags: string[] }>
    >('notes_scan');
    // NoteMeta → NotePreview shim: drop `folder`, rename `modifiedMs`.
    return metas.map((m) => ({
      id: m.id,
      title: m.title,
      preview: m.preview,
      modificationTime: m.modifiedMs,
      tags: m.tags,
    }));
  },

  async seedIfEmpty(): Promise<number> {
    // Rust writes the shared welcome note iff the vault is empty
    // (futo-notes-model::seed_if_empty). Same first run as iOS/Android.
    return invoke<number>('notes_seed_if_empty');
  },

  async readNote(id: string): Promise<string> {
    // Rust command over futo-notes-model::read_note (missing = ""). The
    // command does notes_root() → create_dir_all itself, so this no longer
    // hits the iOS cold-sandbox plugin-fs hang class (no withTimeout needed).
    return invoke<string>('notes_read', { id });
  },

  async writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number> {
    // Single IPC: Rust does the atomic write (temp + rename), optional
    // mtime override, and mtime read-back in one blocking call. The Rust
    // side calls `write_atomic_text` which calls `create_dir_all(parent)`
    // — so a nested ID like `Specs/foo` automatically creates its folder.
    // The command also suppresses the watcher echo for `{id}.md` before the
    // write, so our own edit doesn't bubble back as an external change.
    const modifiedAt =
      typeof modifiedAtMs === 'number' && Number.isFinite(modifiedAtMs) && modifiedAtMs >= 0
        ? Math.trunc(modifiedAtMs)
        : null;
    return await invoke<number>('notes_write', {
      id,
      content,
      modifiedAtMs: modifiedAt,
    });
  },

  async deleteNoteFile(id: string): Promise<void> {
    // Rust command over futo-notes-model::delete_note (missing is not an
    // error). The model does NOT prune empty parents, so do that here to
    // match the prior plugin-fs behavior (no ghost folders after deleting
    // the only note inside).
    await invoke('notes_delete', { id });
    const root = await getNotesRoot();
    await pruneEmptyAncestors(root, noteParentDir(root, id));
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
    return invoke<boolean>('notes_exists', { id });
  },

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
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    });
    return typeof picked === 'string' ? picked : null;
  },

  // ── Folder operations ───────────────────────────────────────────────

  async listFolders(): Promise<FolderEntry[]> {
    return invoke<FolderEntry[]>('fs_list_folders');
  },

  async createFolder(path: string): Promise<void> {
    await invoke<string>('notes_create_folder', { path });
  },

  async renameFolder(fromPath: string, toPath: string): Promise<void> {
    await invoke('notes_rename_folder', { from: fromPath, to: toPath });
  },

  async deleteFolder(path: string): Promise<void> {
    await invoke('notes_delete_folder', { path });
  },

  async moveNote(fromId: string, toId: string): Promise<void> {
    // Explicit old→new relocation (atomic rename, preserves mtime). Maps to
    // notes_rename, which takes (oldId, newId) — the 1:1 replacement for the
    // prior fs_move_note(fromId, toId). Rust resolves any collision and
    // suppresses both filename echoes.
    await invoke<string>('notes_rename', { oldId: fromId, newId: toId });
  },

  async deleteNoteToTrash(id: string): Promise<void> {
    await invoke('notes_delete_to_trash', { id });
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

async function loadAppConfigFile(): Promise<AppConfigFile> {
  let raw: string | null;
  try {
    raw = await tauriFS.readAppData(APP_CONFIG_PATH);
  } catch (err) {
    // On macOS a TCC/permission denial makes the open reject EPERM. Degrade to
    // defaults so settings still load, and surface the error rather than
    // letting it become an unhandled rejection / crash report.
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
  const cfg = await loadAppConfigFile();
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
