import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import type { PlatformFS, NoteFile } from './types';

const notesDirectory = Directory.Documents;
const NOTES_SUBFOLDER = 'futo-notes';

export const capacitorFS: PlatformFS = {
  async listNoteFiles(): Promise<NoteFile[]> {
    const result = await Filesystem.readdir({
      path: NOTES_SUBFOLDER,
      directory: notesDirectory,
    });
    return result.files
      .filter(f => f.name.endsWith('.md'))
      .map(f => ({ name: f.name, mtime: f.mtime || 0 }));
  },

  async readNote(id: string): Promise<string> {
    const result = await Filesystem.readFile({
      path: `${NOTES_SUBFOLDER}/${id}.md`,
      directory: notesDirectory,
      encoding: Encoding.UTF8,
    });
    return result.data as string;
  },

  async writeNote(id: string, content: string): Promise<number> {
    await Filesystem.writeFile({
      path: `${NOTES_SUBFOLDER}/${id}.md`,
      data: content,
      directory: notesDirectory,
      encoding: Encoding.UTF8,
    });
    return Date.now();
  },

  async deleteNoteFile(id: string): Promise<void> {
    await Filesystem.deleteFile({
      path: `${NOTES_SUBFOLDER}/${id}.md`,
      directory: notesDirectory,
    });
  },

  async noteExists(id: string): Promise<boolean> {
    try {
      await Filesystem.stat({
        path: `${NOTES_SUBFOLDER}/${id}.md`,
        directory: notesDirectory,
      });
      return true;
    } catch {
      return false;
    }
  },

  async readAppData(relPath: string): Promise<string | null> {
    try {
      const result = await Filesystem.readFile({
        path: `${NOTES_SUBFOLDER}/${relPath}`,
        directory: notesDirectory,
        encoding: Encoding.UTF8,
      });
      return result.data as string;
    } catch {
      return null;
    }
  },

  async writeAppData(relPath: string, content: string): Promise<void> {
    // Ensure parent directory exists
    const lastSlash = relPath.lastIndexOf('/');
    if (lastSlash > 0) {
      try {
        await Filesystem.mkdir({
          path: `${NOTES_SUBFOLDER}/${relPath.slice(0, lastSlash)}`,
          directory: notesDirectory,
          recursive: true,
        });
      } catch { /* already exists */ }
    }
    await Filesystem.writeFile({
      path: `${NOTES_SUBFOLDER}/${relPath}`,
      data: content,
      directory: notesDirectory,
      encoding: Encoding.UTF8,
    });
  },

  async deleteAppData(relPath: string): Promise<void> {
    try {
      await Filesystem.deleteFile({
        path: `${NOTES_SUBFOLDER}/${relPath}`,
        directory: notesDirectory,
      });
    } catch { /* not found — fine */ }
  },

  async listAppData(dir: string): Promise<string[]> {
    try {
      const result = await Filesystem.readdir({
        path: `${NOTES_SUBFOLDER}/${dir}`,
        directory: notesDirectory,
      });
      return result.files.map(f => f.name);
    } catch {
      return [];
    }
  },

  async saveImage(sourcePath: string): Promise<string> {
    const ext = sourcePath.split('.').pop()?.toLowerCase() || 'jpg';
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 6);
    const filename = `${timestamp}-${rand}.${ext}`;

    await Filesystem.copy({
      from: sourcePath,
      to: `${NOTES_SUBFOLDER}/${filename}`,
      toDirectory: notesDirectory,
    });

    return filename;
  },

  async getImageUrl(filename: string): Promise<string> {
    const result = await Filesystem.getUri({
      path: `${NOTES_SUBFOLDER}/${filename}`,
      directory: notesDirectory,
    });
    return Capacitor.convertFileSrc(result.uri);
  },

  async getAppVersion(): Promise<string> {
    try {
      const { App } = await import('@capacitor/app');
      const info = await App.getInfo();
      return info.version;
    } catch {
      return '0.0.0';
    }
  },

  getPlatformName(): string {
    return Capacitor.getPlatform();
  },
};

/** Ensure the subfolder exists, migrate any .md files from the Documents root. */
export async function ensureCapacitorNotesFolder(): Promise<void> {
  // Create subfolder if it doesn't exist
  try {
    await Filesystem.mkdir({
      path: NOTES_SUBFOLDER,
      directory: notesDirectory,
      recursive: false
    });
  } catch {
    // Already exists — fine
  }

  // Migrate .md files from Documents root into the subfolder
  try {
    const root = await Filesystem.readdir({ path: '', directory: notesDirectory });
    for (const f of root.files) {
      if (f.name.endsWith('.md')) {
        try {
          await Filesystem.rename({
            from: f.name,
            to: `${NOTES_SUBFOLDER}/${f.name}`,
            directory: notesDirectory,
            toDirectory: notesDirectory
          });
        } catch {
          // File with same name already exists in subfolder — skip
        }
      }
    }
  } catch {
    // Root listing failed — nothing to migrate
  }
}
