import type { NotePreview } from '$shared/types/note';

export function getForYouNotes(notes: NotePreview[], limit: number = 3): NotePreview[] {
  if (notes.length === 0 || limit <= 0) return [];
  if (notes.length <= limit) {
    return [...notes].sort(compareNotes);
  }
  const picked: NotePreview[] = [];
  for (const note of notes) {
    if (picked.length < limit) {
      insertSorted(picked, note);
      continue;
    }
    if (compareNotes(note, picked[picked.length - 1]) < 0) {
      picked.pop();
      insertSorted(picked, note);
    }
  }
  return picked;
}

function compareNotes(a: NotePreview, b: NotePreview): number {
  if (a.modificationTime !== b.modificationTime) {
    return b.modificationTime - a.modificationTime;
  }
  return b.id.localeCompare(a.id);
}

function insertSorted(arr: NotePreview[], note: NotePreview): void {
  let i = arr.length;
  while (i > 0 && compareNotes(note, arr[i - 1]) < 0) i--;
  arr.splice(i, 0, note);
}
