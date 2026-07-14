import { isNotFound } from './fsErrors';

export interface AtomicWriteFS {
  writeTextFile(path: string, content: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove?(path: string): Promise<void>;
}

let counter = 0;

export async function writeAtomicText(
  path: string,
  content: string,
  fs: AtomicWriteFS,
): Promise<void> {
  const parent = parentDir(path);
  if (!parent) throw new Error('invalid file path');

  await fs.mkdir(parent, { recursive: true });

  const tmpPath = `${parent}/.sf-tmp-${Date.now()}-${counter++}`;

  try {
    await fs.writeTextFile(tmpPath, content);
    try {
      await fs.rename(tmpPath, path);
    } catch (renameErr) {
      if (!isNotFound(renameErr)) throw renameErr;
      await fs.writeTextFile(tmpPath, content);
      await fs.rename(tmpPath, path);
    }
  } catch (err) {
    try {
      await fs.remove?.(tmpPath);
    } catch {
      /* Intentionally ignored: the operation is best-effort. */
    }
    throw err;
  }
}

function parentDir(p: string): string | null {
  const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (lastSep <= 0) return null;
  return p.slice(0, lastSep);
}
