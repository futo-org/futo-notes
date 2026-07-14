import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DirFileEntry, PlatformFS } from '../types';

export interface TestPlatformFS extends PlatformFS {
  root: string;
  _reset(): void;
  _cleanup(): void;
  /** Test-fixture convenience only; not part of the production platform port. */
  writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number>;
  readNote(id: string): Promise<string>;
}

export function createNodeFS(): TestPlatformFS {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-platform-test-'));

  function full(relative: string): string {
    if (relative.includes('..') || path.isAbsolute(relative)) throw new Error('invalid path');
    return path.join(root, relative);
  }

  function reset(): void {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  }

  return {
    root,
    _reset: reset,
    _cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    async readAppData(relative) {
      try {
        return fs.readFileSync(full(relative), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async writeAppData(relative, content) {
      const destination = full(relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    },
    async deleteAppData(relative) {
      fs.rmSync(full(relative), { force: true });
    },
    async listAppData(relative) {
      const directory = relative === '.' ? root : full(relative);
      try {
        return fs.readdirSync(directory);
      } catch {
        return [];
      }
    },
    async listDirFiles(): Promise<DirFileEntry[]> {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const metadata = fs.statSync(path.join(root, entry.name));
          return { name: entry.name, size: metadata.size, mtime: metadata.mtimeMs };
        });
    },
    async deleteFile(filename) {
      fs.rmSync(full(filename), { force: true });
    },
    async saveImage(sourcePath) {
      const filename = path.basename(sourcePath);
      fs.copyFileSync(sourcePath, full(filename));
      return filename;
    },
    async getImageUrl(filename) {
      return full(filename);
    },
    async getAppVersion() {
      return '0.0.0-test';
    },
    getPlatformName() {
      return 'web';
    },
    async writeNote(id, content, modifiedAtMs) {
      const destination = full(`${id}.md`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
      if (modifiedAtMs !== undefined) {
        const seconds = modifiedAtMs / 1000;
        fs.utimesSync(destination, seconds, seconds);
      }
      return fs.statSync(destination).mtimeMs;
    },
    async readNote(id) {
      try {
        return fs.readFileSync(full(`${id}.md`), 'utf8');
      } catch {
        return '';
      }
    },
  };
}
