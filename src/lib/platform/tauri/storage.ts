import {
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  rename,
  stat,
  writeTextFile,
} from '@tauri-apps/plugin-fs';

import { writeAtomicText, type AtomicWriteFS } from '../atomicWrite';
import { isNotFound } from '../fsErrors';
import { safeAppdataPath } from '../pathSafety';
import type { DirFileEntry, PlatformFS } from '../types';

type TauriStorage = Pick<
  PlatformFS,
  'readAppData' | 'writeAppData' | 'deleteAppData' | 'listAppData' | 'listDirFiles' | 'deleteFile'
>;

interface TauriStorageDependencies {
  getNotesRoot: () => Promise<string>;
}

const FS_READ_TIMEOUT_MS = 8_000;
const pluginFS: AtomicWriteFS = { writeTextFile, rename, mkdir, remove };

function withTimeout<T>(label: string, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${FS_READ_TIMEOUT_MS}ms`)),
      FS_READ_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function dateToMs(date: Date | null | undefined): number {
  return date?.getTime() ?? Date.now();
}

function validateRootFilename(filename: string): void {
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('invalid filename');
  }
}

export function createTauriStorage({ getNotesRoot }: TauriStorageDependencies): TauriStorage {
  return {
    async readAppData(path) {
      const fullPath = safeAppdataPath(await getNotesRoot(), path);
      try {
        if (!(await withTimeout(`exists(${path})`, exists(fullPath)))) return null;
        return await withTimeout(`readAppData(${path})`, readTextFile(fullPath));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async writeAppData(path, content) {
      const fullPath = safeAppdataPath(await getNotesRoot(), path);
      await writeAtomicText(fullPath, content, pluginFS);
    },

    async deleteAppData(path) {
      const fullPath = safeAppdataPath(await getNotesRoot(), path);
      try {
        await remove(fullPath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },

    async listAppData(dir) {
      const fullPath = safeAppdataPath(await getNotesRoot(), dir);
      try {
        return (await readDir(fullPath)).map((entry) => entry.name);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
    },

    async listDirFiles() {
      const root = await getNotesRoot();
      const files = (await readDir(root)).filter((entry) => entry.isFile && entry.name);
      const entries = await Promise.all(
        files.map(async (entry): Promise<DirFileEntry | null> => {
          try {
            const metadata = await stat(`${root}/${entry.name}`);
            return {
              name: entry.name!,
              size: metadata.size,
              mtime: dateToMs(metadata.mtime),
            };
          } catch {
            return null;
          }
        }),
      );
      return entries.filter((entry): entry is DirFileEntry => entry !== null);
    },

    async deleteFile(filename) {
      validateRootFilename(filename);
      await remove(`${await getNotesRoot()}/${filename}`);
    },
  };
}
