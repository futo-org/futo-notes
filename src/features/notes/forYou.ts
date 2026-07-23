import type { NotePreview } from '$shared/types/note';

export function getForYouNotes(notes: NotePreview[], limit: number = 3): NotePreview[] {
  if (limit <= 0) return [];
  return notes.slice(0, limit);
}
