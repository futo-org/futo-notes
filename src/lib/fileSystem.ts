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
  // Rust search engine here so its Tantivy index stays as fresh as MiniSearch
  // (which notes.svelte.ts updates optimistically) — otherwise stale hits.
  void engineNotify('change', `${id}.md`);
  return mtime;
}

export async function deleteNoteFile(id: string): Promise<void> {
  writeSuppressor.recordWrite(`${id}.md`);
  await getFS().deleteNoteFile(id);
  void engineNotify('unlink', `${id}.md`);
}

export async function deleteAllContent(): Promise<void> {
  return getFS().deleteAllContent();
}

export async function noteExists(id: string): Promise<boolean> {
  return getFS().noteExists(id);
}

export async function getUniqueNoteId(baseId: string, excludeId?: string): Promise<string> {
  if (baseId === excludeId || !(await noteExists(baseId))) {
    return baseId;
  }

  let counter = 2;
  let candidateId = `${baseId}-${counter}`;
  while (await noteExists(candidateId)) {
    counter++;
    candidateId = `${baseId}-${counter}`;
  }
  return candidateId;
}

export async function renameNote(
  oldId: string,
  newId: string,
  content: string,
  modifiedAtMs?: number,
): Promise<number> {
  // writeNote + deleteNoteFile each record their own path, suppressing
  // the watcher events that would otherwise surface as "changed/deleted
  // externally" on the active note. Watcher debounce (50ms) is well
  // inside both recordings' TTL, so no head-start is needed here.
  const mtime = await writeNote(newId, content, modifiedAtMs);
  await deleteNoteFile(oldId);
  return mtime;
}

/**
 * Atomic rename — used by drag-drop to relocate a note without rewriting
 * its content. Preserves the file's mtime so the sidebar's mtime-desc
 * sort doesn't bounce the moved row to the top after the disk operation.
 * Records both paths so the watcher events the OS emits don't bubble
 * back as external changes.
 */
export async function moveNoteFile(fromId: string, toId: string): Promise<void> {
  writeSuppressor.recordWrite(`${fromId}.md`);
  writeSuppressor.recordWrite(`${toId}.md`);
  const fs = getFS();
  if (!fs.moveNote) throw new Error('platform does not support atomic note move');
  await fs.moveNote(fromId, toId);
  // Both paths are suppressed from the watcher; keep the Rust engine fresh by
  // re-keying the moved note's index entry from old → new path.
  void engineNotify('rename', `${toId}.md`, `${fromId}.md`);
}

/** Copy an image from a temp path into the notes folder, return just the filename. */
export async function saveImageFile(sourcePath: string): Promise<string> {
  return getFS().saveImage(sourcePath);
}

/** Resolve a local image filename to a web-displayable URL. */
export async function getImageWebPath(filename: string): Promise<string> {
  return getFS().getImageUrl(filename);
}
