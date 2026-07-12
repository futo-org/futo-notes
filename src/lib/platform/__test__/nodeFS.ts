import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DirFileEntry, FolderEntry, PlatformFS, NoteFile, NotePreviewMeta } from '../types';
import { extractTags } from '$lib/rules';

// Mirror futo-notes-model::{make_preview, note_tags} inline rather than
// importing from $lib/notesIndex — that module pulls in searchIndex, which
// imports `./platform` and forms an init cycle under `vi.mock('$lib/platform')`.
function makePreview(content: string): string {
  return content.slice(0, 100).replace(/\n/g, ' ');
}
function noteTags(content: string): string[] {
  return extractTags(content).map((t) => t.replace(/^#/, ''));
}

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

  function walkMd(dir: string, base: string, out: NoteFile[]): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkMd(full, base, out);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const rel = path.relative(base, full).split(path.sep).join('/');
        const stat = fs.statSync(full);
        out.push({ name: rel, mtime: stat.mtimeMs, size: stat.size });
      }
    }
  }

  function walkDirs(dir: string, base: string, out: FolderEntry[]): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const rel = path.relative(base, full).split(path.sep).join('/');
        out.push({ path: rel });
        walkDirs(full, base, out);
      }
    }
  }

  const nodeFS: TestPlatformFS = {
    async listNoteFiles(): Promise<NoteFile[]> {
      const out: NoteFile[] = [];
      walkMd(tmpDir, tmpDir, out);
      return out;
    },

    async scanNotes(): Promise<NotePreviewMeta[]> {
      const files: NoteFile[] = [];
      walkMd(tmpDir, tmpDir, files);
      return files
        .map((f) => {
          const id = f.name.replace(/\.md$/, '');
          const slash = id.lastIndexOf('/');
          const content = fs.readFileSync(path.join(tmpDir, f.name), 'utf-8');
          return {
            id,
            title: slash === -1 ? id : id.slice(slash + 1),
            preview: makePreview(content),
            modificationTime: f.mtime,
            tags: noteTags(content),
          };
        })
        .sort((a, b) => b.modificationTime - a.modificationTime || a.id.localeCompare(b.id));
    },

    async readNote(id: string): Promise<string> {
      const filePath = path.join(tmpDir, `${id}.md`);
      // Missing reads as "" to match production (Tauri notes_read over
      // futo-notes-model::read_note; web.ts). Existence is asked via noteExists.
      if (!fs.existsSync(filePath)) return '';
      return fs.readFileSync(filePath, 'utf-8');
    },

    async writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number> {
      const filePath = path.join(tmpDir, `${id}.md`);
      ensureDir(filePath);
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
      // Best-effort: prune now-empty parent dirs.
      let cursor = path.dirname(filePath);
      while (cursor.startsWith(tmpDir) && cursor !== tmpDir) {
        try {
          if (fs.existsSync(cursor) && fs.readdirSync(cursor).length === 0) {
            fs.rmdirSync(cursor);
          } else {
            break;
          }
        } catch {
          break;
        }
        cursor = path.dirname(cursor);
      }
    },

    async noteExists(id: string): Promise<boolean> {
      return fs.existsSync(path.join(tmpDir, `${id}.md`));
    },

    // Tests control their vault contents explicitly, so seeding is a no-op
    // here (the real welcome-note seed lives in tauri.ts/web.ts). Present so
    // `initNotes()` — which now calls `fs.seedIfEmpty()` — doesn't throw.
    async seedIfEmpty(): Promise<number> {
      return 0;
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

    async listFolders(): Promise<FolderEntry[]> {
      const out: FolderEntry[] = [];
      walkDirs(tmpDir, tmpDir, out);
      return out;
    },

    async createFolder(folderPath: string): Promise<void> {
      const dir = path.join(tmpDir, folderPath);
      fs.mkdirSync(dir, { recursive: true });
    },

    async renameFolder(fromPath: string, toPath: string): Promise<void> {
      const from = path.join(tmpDir, fromPath);
      const to = path.join(tmpDir, toPath);
      if (!fs.existsSync(from)) return;
      ensureDir(to);
      fs.renameSync(from, to);
    },

    async deleteFolder(folderPath: string): Promise<void> {
      const dir = path.join(tmpDir, folderPath);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },

    async moveNote(fromId: string, toId: string): Promise<void> {
      const from = path.join(tmpDir, `${fromId}.md`);
      const to = path.join(tmpDir, `${toId}.md`);
      if (!fs.existsSync(from)) return;
      ensureDir(to);
      fs.renameSync(from, to);
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
