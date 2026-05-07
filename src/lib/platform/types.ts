export interface NoteFile {
  name: string;
  mtime: number;
  /** File size in bytes. Used by sync push-path to short-circuit unchanged files. */
  size: number;
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'rename';
  /** Relative path under the notes root (forward-slash separated). */
  filename: string;
  /** For `rename` events, the previous relative path. The watcher pairs
   *  rename From/To events so consumers can update IDs in place instead
   *  of treating each as a separate add+delete. */
  from?: string;
}

// ── V2 focused interfaces ──────────────────────────────────────────────

/** Entry returned by listDirFiles — name, byte size, mtime in ms. */
export interface DirFileEntry {
  name: string;
  size: number;
  mtime: number;
}

/** Entry returned by listFolders — relative folder path under the notes root. */
export interface FolderEntry {
  /** Relative path from the notes root (e.g. `Specs/sub`). */
  path: string;
}

/** Core file system operations — everything needed for offline-first editing and sync. */
export interface FileSystem {
  listNoteFiles(): Promise<NoteFile[]>;
  readNote(id: string): Promise<string>;
  writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number>;
  deleteNoteFile(id: string): Promise<void>;
  noteExists(id: string): Promise<boolean>;

  readAppData(path: string): Promise<string | null>;
  writeAppData(path: string, content: string): Promise<void>;
  deleteAppData(path: string): Promise<void>;
  listAppData(dir: string): Promise<string[]>;

  /** List all regular files in the notes root with name, size, and mtime. */
  listDirFiles(): Promise<DirFileEntry[]>;
  /** Delete a file by name from the notes root. */
  deleteFile(filename: string): Promise<void>;

  saveImage(sourcePath: string): Promise<string>;
  saveImageBytes?(data: ArrayBuffer, ext: string): Promise<string>;
  getImageUrl(filename: string): Promise<string>;

  getAppVersion(): Promise<string>;
  getPlatformName(): string;

  deleteAllContent(): Promise<void>;

  // ── Folder operations (added with folder-support v1) ──────────────────
  /** List all folders (directories) under the notes root, recursively. */
  listFolders(): Promise<FolderEntry[]>;
  /** Create an empty folder at `path` (relative to the notes root). */
  createFolder(path: string): Promise<void>;
  /** Rename or move a folder from `fromPath` to `toPath`. */
  renameFolder(fromPath: string, toPath: string): Promise<void>;
  /** Delete a folder and all its contents. Routed through trash on
   *  desktop; hard delete on mobile. */
  deleteFolder(path: string): Promise<void>;
  /** Move a note from one ID (relative path without `.md`) to another. */
  moveNote(fromId: string, toId: string): Promise<void>;
  /** Delete a note routed through the system trash on desktop. */
  deleteNoteToTrash?(id: string): Promise<void>;
}

/** Platform-specific capabilities beyond core file I/O. */
export interface NativeCapabilities {
  readBinaryAppData?(path: string): Promise<ArrayBuffer | null>;
  writeBinaryAppData?(path: string, data: ArrayBuffer): Promise<void>;

  pickImage?(): Promise<string | null>;
}

// ── Unified interface (backward compat) ────────────────────────────────

/** Full platform interface — extends both FileSystem and NativeCapabilities. */
export interface PlatformFS extends FileSystem, NativeCapabilities {}

export type PlatformName = 'tauri' | 'web';
