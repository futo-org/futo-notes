import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DirFileEntry, PlatformFS, NoteFile } from '../types';

export interface TestPlatformFS extends PlatformFS {
  _cleanup(): void;
  _reset(): void;
}

export function createNodeFS(): TestPlatformFS {
  let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-test-'));

  function ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const nodeFS: TestPlatformFS = {
    async listNoteFiles(): Promise<NoteFile[]> {
      if (!fs.existsSync(tmpDir)) return [];
      const entries = fs.readdirSync(tmpDir);
      return entries
        .filter((name) => name.endsWith('.md'))
        .map((name) => {
          const stat = fs.statSync(path.join(tmpDir, name));
          return { name, mtime: stat.mtimeMs, size: stat.size };
        });
    },

    async readNote(id: string): Promise<string> {
      const filePath = path.join(tmpDir, `${id}.md`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Note not found: ${id}`);
      }
      return fs.readFileSync(filePath, 'utf-8');
    },

    async writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number> {
      const filePath = path.join(tmpDir, `${id}.md`);
      fs.writeFileSync(filePath, content, 'utf-8');
      if (modifiedAtMs !== undefined) {
        const timeSec = modifiedAtMs / 1000;
        fs.utimesSync(filePath, timeSec, timeSec);
      }
      return fs.statSync(filePath).mtimeMs;
    },

    async deleteNoteFile(id: string): Promise<void> {
      const filePath = path.join(tmpDir, `${id}.md`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    },

    async noteExists(id: string): Promise<boolean> {
      return fs.existsSync(path.join(tmpDir, `${id}.md`));
    },

    async deleteAllContent(): Promise<void> {
      if (!fs.existsSync(tmpDir)) return;
      for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(tmpDir, entry.name);
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    },

    async readAppData(relPath: string): Promise<string | null> {
      const filePath = path.join(tmpDir, relPath);
      if (!fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath, 'utf-8');
    },

    async writeAppData(relPath: string, content: string): Promise<void> {
      const filePath = path.join(tmpDir, relPath);
      ensureDir(filePath);
      fs.writeFileSync(filePath, content, 'utf-8');
    },

    async deleteAppData(relPath: string): Promise<void> {
      const filePath = path.join(tmpDir, relPath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    },

    async listAppData(dir: string): Promise<string[]> {
      const dirPath = path.join(tmpDir, dir);
      if (!fs.existsSync(dirPath)) return [];
      return fs.readdirSync(dirPath);
    },

    async listDirFiles(): Promise<DirFileEntry[]> {
      if (!fs.existsSync(tmpDir)) return [];
      const entries = fs.readdirSync(tmpDir);
      return entries
        .map((name) => {
          const stat = fs.statSync(path.join(tmpDir, name));
          if (!stat.isFile()) return null;
          return { name, size: stat.size, mtime: stat.mtimeMs };
        })
        .filter((e): e is DirFileEntry => e !== null);
    },

    async deleteFile(filename: string): Promise<void> {
      const filePath = path.join(tmpDir, filename);
      fs.unlinkSync(filePath);
    },

    async saveImage(sourcePath: string): Promise<string> {
      const filename = path.basename(sourcePath);
      const dest = path.join(tmpDir, filename);
      fs.copyFileSync(sourcePath, dest);
      return filename;
    },

    async getImageUrl(filename: string): Promise<string> {
      return `file://${path.join(tmpDir, filename)}`;
    },

    async getAppVersion(): Promise<string> {
      return '0.0.0-test';
    },

    getPlatformName(): string {
      return 'web';
    },

    _cleanup(): void {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },

    _reset(): void {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-test-'));
    },
  };

  return nodeFS;
}
