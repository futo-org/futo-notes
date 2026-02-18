import type { PlatformFS, NoteFile } from './types';

// Web platform: no real filesystem, notes are not persisted.
// This allows the UI to render without errors in a plain browser.
export const webFS: PlatformFS = {
  async listNoteFiles(): Promise<NoteFile[]> {
    return [];
  },

  async readNote(_id: string): Promise<string> {
    throw new Error('File I/O not available in web mode');
  },

  async writeNote(_id: string, _content: string): Promise<number> {
    console.warn('writeNote called in web mode — not persisted');
    return Date.now();
  },

  async deleteNoteFile(_id: string): Promise<void> {
    console.warn('deleteNoteFile called in web mode — no-op');
  },

  async noteExists(_id: string): Promise<boolean> {
    return false;
  },
};
