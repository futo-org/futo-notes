import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { FileChangeEvent, PlatformFS, NoteFile } from './types';

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

function fromBytes(data: number[]): ArrayBuffer {
  return new Uint8Array(data).buffer;
}

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
    return invoke<string | null>('appdata_read', { relPath: path });
  },

  async writeAppData(path: string, content: string): Promise<void> {
    await invoke('appdata_write', { relPath: path, content });
  },

  async deleteAppData(path: string): Promise<void> {
    await invoke('appdata_delete', { relPath: path });
  },

  async listAppData(dir: string): Promise<string[]> {
    return invoke<string[]>('appdata_list', { relDir: dir });
  },

  async readBinaryAppData(path: string): Promise<ArrayBuffer | null> {
    const bytes = await invoke<number[] | null>('appdata_read_binary', { relPath: path });
    return bytes ? fromBytes(bytes) : null;
  },

  async writeBinaryAppData(path: string, data: ArrayBuffer): Promise<void> {
    await invoke('appdata_write_binary', { relPath: path, data: toBytes(data) });
  },

  async saveImage(sourcePath: string): Promise<string> {
    return invoke<string>('fs_save_image', { sourcePath });
  },

  async getImageUrl(filename: string): Promise<string> {
    const path = await invoke<string>('fs_get_image_path', { filename });
    return convertFileSrc(path);
  },

  async getAppVersion(): Promise<string> {
    return invoke<string>('app_get_version');
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
}
