import type { PlatformFS, NoteFile } from './types';

// Type for the API exposed by preload.ts via contextBridge
interface ElectronAPI {
  listFiles(): Promise<{ name: string; mtime: number }[]>;
  readFile(filename: string): Promise<string>;
  writeFile(filename: string, content: string, modifiedAtMs?: number): Promise<number>;
  deleteFile(filename: string): Promise<void>;
  fileExists(filename: string): Promise<boolean>;
  getNotesDir(): Promise<string>;
  getPlatform(): Promise<string>;
  getConfig(): Promise<{ notesDir: string; sidebarWidth?: number }>;
  saveConfig(updates: Record<string, unknown>): Promise<void>;
  openDirectoryDialog(): Promise<string | null>;
  onFileChange(callback: (event: { type: string; filename: string }) => void): () => void;
  onMenuAction(callback: (action: string) => void): () => void;
  onNotesDirChanged(callback: (newDir: string) => void): () => void;

  // App data
  readAppData(relPath: string): Promise<string | null>;
  writeAppData(relPath: string, content: string): Promise<void>;
  deleteAppData(relPath: string): Promise<void>;
  listAppData(dir: string): Promise<string[]>;

  // App info
  getAppVersion(): Promise<string>;

  // Images
  saveImage(sourcePath: string): Promise<string>;
  getImageUrl(filename: string): Promise<string>;
  pickImage(): Promise<string | null>;
}

function getAPI(): ElectronAPI {
  return (window as any).electronAPI as ElectronAPI;
}

export const electronFS: PlatformFS = {
  async listNoteFiles(): Promise<NoteFile[]> {
    const files = await getAPI().listFiles();
    return files
      .filter(f => f.name.endsWith('.md'))
      .map(f => ({ name: f.name, mtime: f.mtime }));
  },

  async readNote(id: string): Promise<string> {
    return getAPI().readFile(`${id}.md`);
  },

  async writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number> {
    return getAPI().writeFile(`${id}.md`, content, modifiedAtMs);
  },

  async deleteNoteFile(id: string): Promise<void> {
    return getAPI().deleteFile(`${id}.md`);
  },

  async noteExists(id: string): Promise<boolean> {
    return getAPI().fileExists(`${id}.md`);
  },

  async readAppData(relPath: string): Promise<string | null> {
    return getAPI().readAppData(relPath);
  },

  async writeAppData(relPath: string, content: string): Promise<void> {
    return getAPI().writeAppData(relPath, content);
  },

  async deleteAppData(relPath: string): Promise<void> {
    return getAPI().deleteAppData(relPath);
  },

  async listAppData(dir: string): Promise<string[]> {
    return getAPI().listAppData(dir);
  },

  async saveImage(sourcePath: string): Promise<string> {
    return getAPI().saveImage(sourcePath);
  },

  async getImageUrl(filename: string): Promise<string> {
    return getAPI().getImageUrl(filename);
  },

  async getAppVersion(): Promise<string> {
    return getAPI().getAppVersion();
  },

  getPlatformName(): string {
    return 'electron';
  },

  async pickImage(): Promise<string | null> {
    return getAPI().pickImage();
  },
};

/** Pick an image file via native dialog. Electron-specific UI action. */
export function pickImage(): Promise<string | null> {
  return getAPI().pickImage();
}

export function onFileChange(callback: (event: { type: string; filename: string }) => void): () => void {
  return getAPI().onFileChange(callback);
}

export function onMenuAction(callback: (action: string) => void): () => void {
  return getAPI().onMenuAction(callback);
}

export function onNotesDirChanged(callback: (newDir: string) => void): () => void {
  return getAPI().onNotesDirChanged(callback);
}

export function getConfig(): Promise<{ notesDir: string; sidebarWidth?: number }> {
  return getAPI().getConfig();
}

export function saveElectronConfig(updates: Record<string, unknown>): Promise<void> {
  return getAPI().saveConfig(updates);
}
