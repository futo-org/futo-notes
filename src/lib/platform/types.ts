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
  writeNote(id: string, content: string): Promise<number>;
  deleteNoteFile(id: string): Promise<void>;
  noteExists(id: string): Promise<boolean>;
}

export type PlatformName = 'electron' | 'capacitor' | 'web';
