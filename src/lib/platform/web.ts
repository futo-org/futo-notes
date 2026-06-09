import type { PlatformFS, NoteFile, FolderEntry, NotePreviewMeta } from './types';
import { makePreview, noteTags } from '$lib/notesIndex';

// In-memory note store for web platform (persists within a page session)
const noteStore = new Map<string, { content: string; mtime: number }>();
// Locally-tracked empty folders (web mode has no real filesystem). Folders
// are also implied by note IDs containing `/`.
const emptyFolders = new Set<string>();

// Web platform: notes stored in memory only (cleared on page reload).
// This allows the UI to render in a plain browser and supports dev/test workflows.
export const webFS: PlatformFS = {
  async listNoteFiles(): Promise<NoteFile[]> {
    return Array.from(noteStore.entries()).map(([id, { content, mtime }]) => ({
      name: `${id}.md`,
      mtime,
      size: content.length,
    }));
  },

  async scanNotes(): Promise<NotePreviewMeta[]> {
    return Array.from(noteStore.entries())
      .map(([id, { content, mtime }]) => {
        const slash = id.lastIndexOf('/');
        return {
          id,
          title: slash === -1 ? id : id.slice(slash + 1),
          preview: makePreview(content),
          modificationTime: mtime,
          tags: noteTags(content),
        };
      })
      .sort((a, b) => b.modificationTime - a.modificationTime || a.id.localeCompare(b.id));
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

  async listDirFiles(): Promise<import('./types').DirFileEntry[]> {
    return [];
  },

  async deleteFile(_filename: string): Promise<void> {
    // no-op in web mode
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

  // ── Folder ops (in-memory) ──────────────────────────────────────────

  async listFolders(): Promise<FolderEntry[]> {
    const set = new Set<string>(emptyFolders);
    for (const id of noteStore.keys()) {
      const components = id.split('/');
      for (let i = 1; i < components.length; i++) {
        set.add(components.slice(0, i).join('/'));
      }
    }
    return [...set].sort().map((path) => ({ path }));
  },

  async createFolder(path: string): Promise<void> {
    if (!path) throw new Error('folder path required');
    emptyFolders.add(path);
  },

  async renameFolder(fromPath: string, toPath: string): Promise<void> {
    if (emptyFolders.has(fromPath)) {
      emptyFolders.delete(fromPath);
      emptyFolders.add(toPath);
    }
    const prefix = `${fromPath}/`;
    const moves: Array<[string, string]> = [];
    for (const id of noteStore.keys()) {
      if (id === fromPath) continue;
      if (id.startsWith(prefix)) {
        moves.push([id, `${toPath}/${id.slice(prefix.length)}`]);
      }
    }
    for (const [oldId, newId] of moves) {
      const v = noteStore.get(oldId);
      if (!v) continue;
      noteStore.set(newId, v);
      noteStore.delete(oldId);
    }
    // Move any sub-folder records too
    const folderMoves: Array<[string, string]> = [];
    for (const f of emptyFolders) {
      if (f === fromPath) continue;
      if (f.startsWith(prefix)) {
        folderMoves.push([f, `${toPath}/${f.slice(prefix.length)}`]);
      }
    }
    for (const [oldF, newF] of folderMoves) {
      emptyFolders.delete(oldF);
      emptyFolders.add(newF);
    }
  },

  async deleteFolder(path: string): Promise<void> {
    emptyFolders.delete(path);
    const prefix = `${path}/`;
    const toRemove: string[] = [];
    for (const id of noteStore.keys()) {
      if (id.startsWith(prefix)) toRemove.push(id);
    }
    for (const id of toRemove) noteStore.delete(id);
    const folderRemove: string[] = [];
    for (const f of emptyFolders) {
      if (f.startsWith(prefix)) folderRemove.push(f);
    }
    for (const f of folderRemove) emptyFolders.delete(f);
  },

  async moveNote(fromId: string, toId: string): Promise<void> {
    const v = noteStore.get(fromId);
    if (!v) return;
    noteStore.set(toId, v);
    noteStore.delete(fromId);
  },
};
