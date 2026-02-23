/** Electron bridge API — shared between preload.ts and platform/electron.ts. */
export interface ElectronAPI {
  // Filesystem
  listFiles(): Promise<{ name: string; mtime: number }[]>;
  readFile(filename: string): Promise<string>;
  writeFile(filename: string, content: string, modifiedAtMs?: number): Promise<number>;
  deleteFile(filename: string): Promise<void>;
  deleteAllContent(): Promise<void>;
  fileExists(filename: string): Promise<boolean>;

  // App
  getNotesDir(): Promise<string>;
  getPlatform(): Promise<string>;
  getConfig(): Promise<{ notesDir: string; sidebarWidth?: number }>;
  saveConfig(updates: Record<string, unknown>): Promise<void>;
  getAppVersion(): Promise<string>;

  // Dialogs
  openDirectoryDialog(): Promise<string | null>;
  pickImage(): Promise<string | null>;

  // App data (dotfiles in notes directory)
  readAppData(relPath: string): Promise<string | null>;
  writeAppData(relPath: string, content: string): Promise<void>;
  deleteAppData(relPath: string): Promise<void>;
  listAppData(dir: string): Promise<string[]>;

  // Images
  saveImage(sourcePath: string): Promise<string>;
  getImageUrl(filename: string): Promise<string>;

  // Supersearch
  supersearchDownload(serverUrl: string, token: string): Promise<void>;
  supersearchQuery(queryVector: number[], topK: number): Promise<Array<{ chunkId: number; uuid: string; chunkText: string; distance: number }>>;
  supersearchClose(): Promise<void>;

  // Events from main process
  onFileChange(callback: (event: { type: string; filename: string }) => void): () => void;
  onMenuAction(callback: (action: string) => void): () => void;
  onNotesDirChanged(callback: (newDir: string) => void): () => void;
}
