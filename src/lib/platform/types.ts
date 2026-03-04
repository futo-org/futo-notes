export interface NoteFile {
  name: string;
  mtime: number;
}

export interface FileChangeEvent {
  type: 'add' | 'change' | 'unlink';
  filename: string;
}

export interface PlatformFS {
  listNoteFiles(): Promise<NoteFile[]>;
  readNote(id: string): Promise<string>;
  writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number>;
  deleteNoteFile(id: string): Promise<void>;
  noteExists(id: string): Promise<boolean>;

  // App data (prefs, crash logs, heartbeat — dotfiles in the notes directory)
  readAppData(path: string): Promise<string | null>;
  writeAppData(path: string, content: string): Promise<void>;
  deleteAppData(path: string): Promise<void>;
  listAppData(dir: string): Promise<string[]>;

  // Images
  saveImage(sourcePath: string): Promise<string>;
  getImageUrl(filename: string): Promise<string>;

  // App info
  getAppVersion(): Promise<string>;
  getPlatformName(): string;

  // Bulk operations
  deleteAllContent(): Promise<void>;

  // Binary app data (supersearch artifacts)
  readBinaryAppData?(path: string): Promise<ArrayBuffer | null>;
  writeBinaryAppData?(path: string, data: ArrayBuffer): Promise<void>;

  // Supersearch (native platforms)
  supersearchDownload?(serverUrl: string, token: string): Promise<void>;
  supersearchHasArtifacts?(): Promise<boolean>;
  supersearchQuery?(
    queryVector: number[],
    topK: number,
  ): Promise<Array<{ chunkId: number; uuid: string; chunkText: string; startOffset: number; endOffset: number; score: number }>>;
  supersearchNoteVector?(uuid: string): Promise<number[]>;
  supersearchAllNoteVectors?(): Promise<Array<{ uuid: string; vector: number[] }>>;

  // Optional platform-specific
  pickImage?(): Promise<string | null>;
}

export type PlatformName = 'tauri' | 'web';
