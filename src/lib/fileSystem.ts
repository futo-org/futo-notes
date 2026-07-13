import { getFS } from './platform';
import type { NoteFile } from './platform';
import { writeSuppressor } from './writeSuppression';
import { engineNotify } from '$features/search/searchEngine';

export type { NoteFile };

export async function listNoteFiles(): Promise<NoteFile[]> {
  return getFS().listNoteFiles();
}

export async function readNote(id: string): Promise<string> {
  return getFS().readNote(id);
}

export async function writeNote(
  id: string,
  content: string,
  modifiedAtMs?: number,
): Promise<number> {
  // Record before the write so the OS-emitted watcher event for our own
  // write doesn't bubble back to syncManager as "changed externally".
  writeSuppressor.recordWrite(`${id}.md`);
  const mtime = await getFS().writeNote(id, content, modifiedAtMs);
  // Our own write is suppressed from the watcher (recordWrite above), so the
  // watcher-driven engineNotify in NotesShell never fires for it. Notify the
  // Rust search engine here so its Tantivy index stays fresh — otherwise the
  // watcher suppression above would leave stale hits.
  void engineNotify('change', `${id}.md`);
  return mtime;
}

export async function deleteNoteFile(id: string): Promise<void> {
  writeSuppressor.recordWrite(`${id}.md`);
  await getFS().deleteNoteFile(id);
  void engineNotify('unlink', `${id}.md`);
}

/**
 * Delete a note routed through the OS trash where the platform supports it
 * (desktop, recoverable); falls back to the permanent `deleteNoteFile` on
 * platforms without `deleteNoteToTrash` (e.g. web).
 */
export async function deleteNoteFileToTrash(id: string): Promise<void> {
  writeSuppressor.recordWrite(`${id}.md`);
  const fs = getFS();
  if (fs.deleteNoteToTrash) {
    await fs.deleteNoteToTrash(id);
  } else {
    await fs.deleteNoteFile(id);
  }
  void engineNotify('unlink', `${id}.md`);
}

export async function deleteAllContent(): Promise<void> {
  return getFS().deleteAllContent();
}

export async function noteExists(id: string): Promise<boolean> {
  return getFS().noteExists(id);
}

/**
 * Create a note from a folder (`""` = root) + title with its initial content,
 * written atomically. The platform layer resolves the id collision (`-2`,
 * `-3`, … — Rust `get_unique_note_id` on desktop/native, the in-store probe on
 * web/test) and returns the final id + mtime. Atomic-create: a write failure
 * leaves no zero-byte orphan behind. Records the resolved path so the watcher
 * event for our own write doesn't bubble back as an external change.
 */
export async function createNoteFile(
  folder: string,
  title: string,
  content: string,
): Promise<{ id: string; mtime: number }> {
  const { id, mtime } = await getFS().createNote(folder, title, content);
  writeSuppressor.recordWrite(`${id}.md`);
  // The Rust/web create writes the file outside the writeNote chokepoint, so
  // notify the search engine here to keep it as fresh as the optimistic cache.
  void engineNotify('change', `${id}.md`);
  return { id, mtime };
}

/**
 * Rename/move a note without rewriting its content — used by title-rename
 * and drag-drop. The platform layer resolves the id collision and does an
 * atomic rename where supported (preserving the file's mtime so the
 * sidebar's mtime-desc sort doesn't bounce the moved row to the top).
 * Records both the requested and resolved paths so the watcher events the
 * OS emits don't bubble back as external changes. Returns the final id.
 */
export async function moveNoteFile(fromId: string, toId: string): Promise<string> {
  writeSuppressor.recordWrite(`${fromId}.md`);
  writeSuppressor.recordWrite(`${toId}.md`);
  const finalId = await getFS().renameNote(fromId, toId);
  if (finalId !== toId) writeSuppressor.recordWrite(`${finalId}.md`);
  // Both paths are suppressed from the watcher; keep the Rust engine fresh by
  // re-keying the moved note's index entry from old → new path.
  void engineNotify('rename', `${finalId}.md`, `${fromId}.md`);
  return finalId;
}

/** Copy an image from a temp path into the notes folder, return just the filename. */
export async function saveImageFile(sourcePath: string): Promise<string> {
  return getFS().saveImage(sourcePath);
}

/** Resolve a local image filename to a web-displayable URL. */
export async function getImageWebPath(filename: string): Promise<string> {
  return getFS().getImageUrl(filename);
}
