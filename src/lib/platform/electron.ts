import type { PlatformFS, NoteFile } from './types';

// Type for the API exposed by preload.ts via contextBridge
interface ElectronAPI {
  listFiles(): Promise<{ name: string; mtime: number }[]>;
  readFile(filename: string): Promise<string>;
  writeFile(filename: string, content: string): Promise<number>;
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

  async writeNote(id: string, content: string): Promise<number> {
    return getAPI().writeFile(`${id}.md`, content);
  },

  async deleteNoteFile(id: string): Promise<void> {
    return getAPI().deleteFile(`${id}.md`);
  },

  async noteExists(id: string): Promise<boolean> {
    return getAPI().fileExists(`${id}.md`);
  },
};

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
