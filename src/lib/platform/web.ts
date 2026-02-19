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

  async writeNote(_id: string, _content: string, _modifiedAtMs?: number): Promise<number> {
    console.warn('writeNote called in web mode — not persisted');
    return Date.now();
  },

  async deleteNoteFile(_id: string): Promise<void> {
    console.warn('deleteNoteFile called in web mode — no-op');
  },

  async deleteAllContent(): Promise<void> {
    // no-op
  },

  async noteExists(_id: string): Promise<boolean> {
    return false;
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
