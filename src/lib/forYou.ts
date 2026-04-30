import type { NotePreview } from '../types';

export function getForYouNotes(
  notes: NotePreview[],
  limit: number = 3,
): NotePreview[] {
  if (notes.length === 0) return [];
  return [...notes]
    .sort((a, b) => b.modificationTime - a.modificationTime)
    .slice(0, limit);
}
