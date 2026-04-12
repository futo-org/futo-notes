import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import {
  readTextFile,
  writeTextFile,
  readFile,
  writeFile,
  readDir,
  remove,
  mkdir,
  rename,
} from '@tauri-apps/plugin-fs';
import type { FileChangeEvent, PlatformFS, NoteFile } from './types';
import { safeAppdataPath } from './pathSafety';
import { writeAtomicText } from './atomicWrite';
import type { AtomicWriteFS } from './atomicWrite';

interface NoteFileRow {
  name: string;
  mtime: number;
}

interface AppConfig {
  notesDir: string;
  sidebarWidth?: number;
  graphSidebarWidth?: number;
  isCustomDir: boolean;
  defaultNotesDir: string;
}

interface AppConfigUpdates {
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

function toI64(value?: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.trunc(value);
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

// ── Appdata helpers (plugin-fs) ──────────────────────────────────────

let _notesRoot: string | null = null;

async function getNotesRoot(): Promise<string> {
  if (_notesRoot) return _notesRoot;
  const config = await invoke<AppConfig>('app_get_config');
  _notesRoot = config.notesDir;
  return _notesRoot;
}

/** Reset the cached notes root (called when the user changes notes dir). */
export function resetNotesRootCache(): void {
  _notesRoot = null;
}

// String matching is the best available heuristic for detecting "not found" errors
// from @tauri-apps/plugin-fs, which does not expose typed error codes. Known fragility:
// if the plugin changes its error message wording, this will need updating.
function isNotFound(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('not found') || msg.includes('no such file') || msg.includes('notfound');
  }
  return false;
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
    const files = await invoke<NoteFileRow[]>('fs_list_note_files');
    return files
      .filter((file) => file.name.endsWith('.md'))
      .map((file) => ({ name: file.name, mtime: file.mtime }));
  },

  async readNote(id: string): Promise<string> {
    return invoke<string>('fs_read_note', { id });
  },

  async writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number> {
    return invoke<number>('fs_write_note', {
      id,
      content,
      modifiedAtMs: toI64(modifiedAtMs),
    });
  },

  async deleteNoteFile(id: string): Promise<void> {
    await invoke('fs_delete_note_file', { id });
  },

  async deleteAllContent(): Promise<void> {
    await invoke('fs_delete_all_content');
  },

  async noteExists(id: string): Promise<boolean> {
    return invoke<boolean>('fs_note_exists', { id });
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

  async saveImage(sourcePath: string): Promise<string> {
    return invoke<string>('fs_save_image', { sourcePath });
  },

  async saveImageBytes(data: ArrayBuffer, ext: string): Promise<string> {
    return invoke<string>('fs_save_image_bytes', { data: toBytes(data), ext });
  },

  async getImageUrl(filename: string): Promise<string> {
    const path = await invoke<string>('fs_get_image_path', { filename });
    return convertFileSrc(path);
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

export async function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>('app_get_config');
}

export async function saveConfig(updates: AppConfigUpdates): Promise<void> {
  await invoke('app_save_config', { updates });
}

export async function setNotesDir(dir: string | null): Promise<void> {
  await invoke('app_set_notes_dir', { dir });
  resetNotesRootCache();
}
