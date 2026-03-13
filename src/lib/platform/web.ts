import type { PlatformFS, NoteFile } from './types';

// In-memory note store for web platform (persists within a page session)
const noteStore = new Map<string, { content: string; mtime: number }>();

// Web platform: notes stored in memory only (cleared on page reload).
// This allows the UI to render in a plain browser and supports dev/test workflows.
export const webFS: PlatformFS = {
  async listNoteFiles(): Promise<NoteFile[]> {
    return Array.from(noteStore.entries()).map(([id, { mtime }]) => ({
      name: id,
      mtime,
    }));
  },

  async readNote(id: string): Promise<string> {
    const note = noteStore.get(id);
    if (!note) throw new Error(`Note not found: ${id}`);
    return note.content;
  },

  async writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number> {
    const mtime = modifiedAtMs ?? Date.now();
    noteStore.set(id, { content, mtime });
    return mtime;
  },

  async deleteNoteFile(id: string): Promise<void> {
    noteStore.delete(id);
  },

  async deleteAllContent(): Promise<void> {
    noteStore.clear();
  },

  async noteExists(id: string): Promise<boolean> {
    return noteStore.has(id);
  },

  async readAppData(_path: string): Promise<string | null> {
    return null;
  },

  async writeAppData(_path: string, _content: string): Promise<void> {
    // no-op
  },

  async deleteAppData(_path: string): Promise<void> {
    // no-op
  },

  async listAppData(_dir: string): Promise<string[]> {
    return [];
  },

  async saveImage(_sourcePath: string): Promise<string> {
    throw new Error('Image saving not available in web mode');
  },

  async getImageUrl(_filename: string): Promise<string> {
    throw new Error('Image URLs not available in web mode');
  },

  async getAppVersion(): Promise<string> {
    return '0.0.0-web';
  },

  getPlatformName(): string {
    return 'web';
  },
};
