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
}

export type PlatformName = 'electron' | 'capacitor' | 'web';
