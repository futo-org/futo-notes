import type { NotePreview } from '../../types';
import { getFS, platformName } from '../platform';
import { loadSyncState, findIdForUuid } from '../syncState';
import { vectorSearch } from './vectorSearch';

export interface SimilarNote {
  noteId: string;
  title: string;
  preview: string;
  score: number;
}

export async function getSimilarNotes(
  noteId: string,
  notes: NotePreview[],
  topK: number,
): Promise<SimilarNote[]> {
  const fs = getFS();
  if (platformName !== 'tauri' || !fs.supersearchNoteVector) {
    throw new Error('Similar notes requires Tauri platform with supersearch artifacts');
  }

  // Look up UUID for this note
  const syncState = await loadSyncState();
  const uuid = syncState.uuidById[noteId] ?? noteId;

  // Get the averaged vector for this note
  const vector = await fs.supersearchNoteVector(uuid);

  // Search for similar notes (request extra to account for self-match)
  const results = await vectorSearch(new Float32Array(vector), topK + 1);

  // Build a lookup from note id to NotePreview
  const noteMap = new Map<string, NotePreview>();
  for (const note of notes) {
    noteMap.set(note.id, note);
  }

  // Map results back to note IDs, filter out self
  const similar: SimilarNote[] = [];
  for (const result of results) {
    const resultId = findIdForUuid(syncState, result.uuid) ?? result.uuid;
    if (resultId === noteId) continue;

    const note = noteMap.get(resultId);
    if (!note) continue;

    similar.push({
      noteId: resultId,
      title: note.title,
      preview: note.preview,
      score: result.score,
    });

    if (similar.length >= topK) break;
  }

  return similar;
}
