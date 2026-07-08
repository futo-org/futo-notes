/** Atomic file write: write to temp then rename. Prevents corruption on crash/power loss. */

import { isNotFound } from './fsErrors';

export interface AtomicWriteFS {
  writeTextFile(path: string, content: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove?(path: string): Promise<void>;
}

let counter = 0;

/**
 * Atomically write text to a file by writing to a temp file then renaming.
 * Mirrors Rust `write_atomic_text` in `futo-notes-core/src/files.rs`.
 */
export async function writeAtomicText(
  path: string,
  content: string,
  fs: AtomicWriteFS,
): Promise<void> {
  const parent = parentDir(path);
  if (!parent) throw new Error('invalid file path');

  await fs.mkdir(parent, { recursive: true });

  // Short temp name to avoid exceeding filesystem limits (ext4: 255 bytes).
  // Counter disambiguates concurrent writes within the same millisecond.
  const tmpPath = `${parent}/.sf-tmp-${Date.now()}-${counter++}`;

  try {
    await fs.writeTextFile(tmpPath, content);
    try {
      await fs.rename(tmpPath, path);
    } catch (renameErr) {
      // On macOS, cloud/file-provider agents (iCloud, Dropbox, antivirus) can
      // consume the freshly-created temp file before the rename, making rename
      // reject ENOENT. Re-materialize the temp and rename once more. Only retry
      // not-found errors so genuine disk-full/EPERM on the target still surface.
      if (!isNotFound(renameErr)) throw renameErr;
      await fs.writeTextFile(tmpPath, content);
      await fs.rename(tmpPath, path);
    }
  } catch (err) {
    // Best-effort cleanup of the temp file
    try {
      await fs.remove?.(tmpPath);
    } catch {
      // Ignore cleanup failures
    }
    throw err;
  }
}

/** Extract the parent directory from a path (works with both / and \ separators). */
function parentDir(p: string): string | null {
  const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (lastSep <= 0) return null;
  return p.slice(0, lastSep);
}
