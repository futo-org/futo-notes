import type { PlatformFS, NoteFile } from './types';
import type { ElectronAPI } from '@desktop/electron/api';

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

  async deleteAllContent(): Promise<void> {
    return getAPI().deleteAllContent();
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

  async supersearchDownload(serverUrl: string, token: string): Promise<void> {
    return getAPI().supersearchDownload(serverUrl, token);
  },

  async supersearchHasArtifacts(): Promise<boolean> {
    return getAPI().supersearchHasArtifacts();
  },

  async supersearchQuery(
    queryVector: number[],
    topK: number,
  ): Promise<Array<{ chunkId: number; uuid: string; chunkText: string; startOffset: number; endOffset: number; score: number }>> {
    return getAPI().supersearchQuery(queryVector, topK);
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
