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
import { ensureSafeRelativePath, safeAppdataPath } from '../pathSafety';
import type { DirFileEntry, PlatformFS } from '../types';

type TauriStorage = Pick<
  PlatformFS,
  'readAppData' | 'writeAppData' | 'deleteAppData' | 'listAppData' | 'listVaultFiles' | 'deleteFile'
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

    async listVaultFiles(include) {
      const root = await getNotesRoot();

      // Folders are part of the vault: a note can sit in one, and so can the
      // image it shows. Listing only the top level is why the desktop images
      // tab showed one picture for a vault that had several (reported
      // 2026-09-16). Dot-directories hold app data, not user files, and a
      // symlinked directory could point anywhere or back at the vault itself.
      async function walk(prefix: string): Promise<DirFileEntry[]> {
        const directory = prefix ? `${root}/${prefix}` : root;
        let entries: Awaited<ReturnType<typeof readDir>>;
        try {
          entries = await readDir(directory);
        } catch {
          return [];
        }
        const collected = await Promise.all(
          entries.map(async (entry): Promise<DirFileEntry[]> => {
            if (!entry.name || entry.name.startsWith('.')) return [];
            const path = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory) return entry.isSymlink ? [] : walk(path);
            if (!entry.isFile || !include(path)) return [];
            try {
              const metadata = await stat(`${root}/${path}`);
              return [{ name: path, size: metadata.size, mtime: dateToMs(metadata.mtime) }];
            } catch {
              // Skip what cannot be read (a broken symlink, a race with a
              // delete) — matches the Rust scan's `filter_map(Result::ok)`.
              return [];
            }
          }),
        );
        return collected.flat();
      }

      return walk('');
    },

    async deleteFile(path) {
      ensureSafeRelativePath(path);
      await remove(`${await getNotesRoot()}/${path}`);
    },
  };
}
