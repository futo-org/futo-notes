import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSafeRelativePath } from '../pathSafety';
import type { DirFileEntry, PlatformFS } from '../types';

export interface TestPlatformFS extends PlatformFS {
  root: string;
  _reset(): void;
  _cleanup(): void;
  /** Test-fixture convenience only; not part of the production platform port. */
  writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number>;
}

export function createNodeFS(): TestPlatformFS {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-platform-test-'));

  // Same traversal rule the Tauri adapter applies, so a test that asserts a
  // rejection is asserting the shipped one.
  function full(relative: string): string {
    ensureSafeRelativePath(relative);
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
    async listVaultFiles(include: (path: string) => boolean): Promise<DirFileEntry[]> {
      const walk = (prefix: string): DirFileEntry[] =>
        fs
          .readdirSync(prefix ? path.join(root, prefix) : root, { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith('.'))
          .flatMap((entry) => {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) return walk(relative);
            if (!entry.isFile() || !include(relative)) return [];
            const metadata = fs.statSync(path.join(root, relative));
            return [{ name: relative, size: metadata.size, mtime: metadata.mtimeMs }];
          });
      return walk('');
    },
    async deleteFile(filename) {
      fs.rmSync(full(filename), { force: true });
    },
    async getImageUrl(filename) {
      return full(filename);
    },
    async getAppVersion() {
      return '0.0.0-test';
    },
    async writeClipboardText(_text) {},
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
  };
}
