import type { NotePreview } from '../types';

/**
 * Return the `limit` notes with the most-recent modificationTime.
 *
 * Uses partial selection rather than a full sort. The caller in
 * ForYouPage passes the full notes array on every save (~once per
 * 500ms of typing), so paying O(n log n) just to keep the top 3 was a
 * waste. This is O(n * limit) — for limit=3 that's three linear
 * passes, easily inlined and cache-friendly.
 *
 * Ties broken by id (lexicographic, descending) so results are stable
 * across renders even when several notes share an mtime.
 */
export function getForYouNotes(
  notes: NotePreview[],
  limit: number = 3,
): NotePreview[] {
  if (notes.length === 0 || limit <= 0) return [];
  if (notes.length <= limit) {
    // Small input — sort behaves the same as the original code path.
    return [...notes].sort(compareNotes);
  }
  // Partial selection: maintain `picked` in sorted order, replacing
  // the weakest when we find a stronger candidate.
  const picked: NotePreview[] = [];
  for (const note of notes) {
    if (picked.length < limit) {
      // Insertion sort into the picked array.
      insertSorted(picked, note);
      continue;
    }
    // Compare with the current weakest (last entry).
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
