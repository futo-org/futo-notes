export interface NoteFile {
  name: string;
  mtime: number;
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink';
  filename: string;
}

// ── V2 focused interfaces ──────────────────────────────────────────────

/** Entry returned by listDirFiles — name, byte size, mtime in ms. */
export interface DirFileEntry {
  name: string;
  size: number;
  mtime: number;
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
}

/** Platform-specific capabilities beyond core file I/O. */
export interface NativeCapabilities {
  readBinaryAppData?(path: string): Promise<ArrayBuffer | null>;
  writeBinaryAppData?(path: string, data: ArrayBuffer): Promise<void>;

  supersearchDownload?(serverUrl: string, token: string): Promise<void>;
  supersearchHasArtifacts?(): Promise<boolean>;
  supersearchQuery?(
    queryVector: number[],
    topK: number,
  ): Promise<Array<{ chunkId: number; uuid: string; chunkText: string; startOffset: number; endOffset: number; score: number }>>;
  supersearchNoteVector?(uuid: string): Promise<number[]>;
  supersearchAllNoteVectors?(): Promise<Array<{ uuid: string; vector: number[] }>>;

  pickImage?(): Promise<string | null>;
}

// ── Unified interface (backward compat) ────────────────────────────────

/** Full platform interface — extends both FileSystem and NativeCapabilities. */
export interface PlatformFS extends FileSystem, NativeCapabilities {}

export type PlatformName = 'tauri' | 'web';
