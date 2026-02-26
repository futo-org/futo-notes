import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PlatformFS, NoteFile } from './types';

const notesDirectory = Directory.Documents;
const NOTES_SUBFOLDER = 'futo-notes';
interface FolderImportPlugin {
  setFileModificationTime(options: { filename: string; mtime: number }): Promise<void>;
}
interface StorageAccessPlugin {
  checkAllFilesAccess(): Promise<{ granted: boolean }>;
  requestAllFilesAccess(): Promise<{ granted: boolean }>;
}
const FolderImport = registerPlugin<FolderImportPlugin>('FolderImport');
const StorageAccess = registerPlugin<StorageAccessPlugin>('StorageAccess');

function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(chunks.join(''));
}

function fromBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function ensureAppDataParent(relPath: string): Promise<void> {
  const lastSlash = relPath.lastIndexOf('/');
  if (lastSlash <= 0) return;

  try {
    await Filesystem.mkdir({
      path: `${NOTES_SUBFOLDER}/${relPath.slice(0, lastSlash)}`,
      directory: notesDirectory,
      recursive: true,
    });
  } catch { /* already exists */ }
}

async function ensureAndroidDeviceStorageAccess(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;

  try {
    const status = await StorageAccess.checkAllFilesAccess();
    if (status.granted) return;

    const result = await StorageAccess.requestAllFilesAccess();
    if (result.granted) return;
  } catch {
    // Fall through and throw deterministic error below.
  }

  throw new Error('Device storage access required: enable "Allow access to manage all files" for FUTO Notes in Android settings.');
}

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

  async writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number> {
    await Filesystem.writeFile({
      path: `${NOTES_SUBFOLDER}/${id}.md`,
      data: content,
      directory: notesDirectory,
      encoding: Encoding.UTF8,
    });
    if (typeof modifiedAtMs === 'number' && Number.isFinite(modifiedAtMs) && modifiedAtMs >= 0) {
      try {
        await FolderImport.setFileModificationTime({ filename: `${id}.md`, mtime: modifiedAtMs });
      } catch {
        // Best-effort; fallback mtime remains write time
      }
      return modifiedAtMs;
    }
    return Date.now();
  },

  async deleteNoteFile(id: string): Promise<void> {
    await Filesystem.deleteFile({
      path: `${NOTES_SUBFOLDER}/${id}.md`,
      directory: notesDirectory,
    });
  },

  async deleteAllContent(): Promise<void> {
    const result = await Filesystem.readdir({
      path: NOTES_SUBFOLDER,
      directory: notesDirectory,
    });
    for (const entry of result.files) {
      // Delete everything including hidden files/folders
      try {
        if (entry.type === 'directory') {
          await Filesystem.rmdir({
            path: `${NOTES_SUBFOLDER}/${entry.name}`,
            directory: notesDirectory,
            recursive: true,
          });
        } else {
          await Filesystem.deleteFile({
            path: `${NOTES_SUBFOLDER}/${entry.name}`,
            directory: notesDirectory,
          });
        }
      } catch { /* best-effort */ }
    }
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
    await ensureAppDataParent(relPath);
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

  async readBinaryAppData(relPath: string): Promise<ArrayBuffer | null> {
    try {
      const result = await Filesystem.readFile({
        path: `${NOTES_SUBFOLDER}/${relPath}`,
        directory: notesDirectory,
      });
      return fromBase64(result.data as string);
    } catch {
      return null;
    }
  },

  async writeBinaryAppData(relPath: string, data: ArrayBuffer): Promise<void> {
    await ensureAppDataParent(relPath);
    await Filesystem.writeFile({
      path: `${NOTES_SUBFOLDER}/${relPath}`,
      data: toBase64(data),
      directory: notesDirectory,
    });
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
  await ensureAndroidDeviceStorageAccess();

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
