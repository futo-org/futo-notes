import { isNotFound } from './fsErrors';

export interface AtomicWriteFS {
  writeTextFile(path: string, content: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove?(path: string): Promise<void>;
}

let counter = 0;

/** The temp names `writeAtomicText` makes: `.sf-tmp-<epoch ms>-<counter>`. The Rust
 * engine's own temps carry a pid too (`.sf-tmp-<pid>-<ms>-<seq>`) and do not match. */
const ATOMIC_TEMP_NAME = /^\.sf-tmp-(\d{10,})-\d+$/;

/** A temp this old belongs to a write that died with its process (a write takes
 * milliseconds); younger ones may be a live write, in this app or another. */
export const STALE_TEMP_MIN_AGE_MS = 60_000;

/** True for a leftover `writeAtomicText` temp file: our exact name pattern AND old
 * enough that no live write can still own it. Anything else — a user's file, the
 * engine's temps — is never stale. */
export function isStaleAtomicTemp(name: string, now: number): boolean {
  const created = ATOMIC_TEMP_NAME.exec(name);
  if (!created) return false;
  return now - Number(created[1]) >= STALE_TEMP_MIN_AGE_MS;
}

export interface TempSweepFS {
  readDir(path: string): Promise<Array<{ name: string; isFile: boolean }>>;
  remove(path: string): Promise<void>;
}

/** Deletes stale `writeAtomicText` temps directly inside `dir` (not recursive).
 * Best-effort by design — a failure here must never get in the way of launching. */
export async function sweepStaleAtomicTemps(
  dir: string,
  fs: TempSweepFS,
  now = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  let entries: Awaited<ReturnType<TempSweepFS['readDir']>>;
  try {
    entries = await fs.readDir(dir);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isFile || !isStaleAtomicTemp(entry.name, now)) continue;
    try {
      await fs.remove(`${dir}/${entry.name}`);
      removed.push(entry.name);
    } catch {
      /* Intentionally ignored: it will be retried at the next launch. */
    }
  }
  return removed;
}

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
