import { getFS } from './platform';
import type { NoteFile } from './platform';
import { writeSuppressor } from './writeSuppression';

export type { NoteFile };

export async function listNoteFiles(): Promise<NoteFile[]> {
  return getFS().listNoteFiles();
}

export async function readNote(id: string): Promise<string> {
  return getFS().readNote(id);
}

export async function writeNote(id: string, content: string, modifiedAtMs?: number): Promise<number> {
  // Record before the write so the OS-emitted watcher event for our own
  // write doesn't bubble back to syncManager as "changed externally".
  writeSuppressor.recordWrite(`${id}.md`);
  return getFS().writeNote(id, content, modifiedAtMs);
}

export async function deleteNoteFile(id: string): Promise<void> {
  writeSuppressor.recordWrite(`${id}.md`);
  return getFS().deleteNoteFile(id);
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

export async function renameNote(oldId: string, newId: string, content: string, modifiedAtMs?: number): Promise<number> {
  // writeNote + deleteNoteFile each record their own path, suppressing
  // the watcher events that would otherwise surface as "changed/deleted
  // externally" on the active note. Watcher debounce (50ms) is well
  // inside both recordings' TTL, so no head-start is needed here.
  const mtime = await writeNote(newId, content, modifiedAtMs);
  await deleteNoteFile(oldId);
  return mtime;
}

/** Copy an image from a temp path into the notes folder, return just the filename. */
export async function saveImageFile(sourcePath: string): Promise<string> {
  return getFS().saveImage(sourcePath);
}

/** Resolve a local image filename to a web-displayable URL. */
export async function getImageWebPath(filename: string): Promise<string> {
  return getFS().getImageUrl(filename);
}
