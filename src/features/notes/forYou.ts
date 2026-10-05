import type { NotePreview } from '$shared/types/note';

export const FOR_YOU_LIMIT = 3;

export function getForYouNotes(recentIds: string[], notes: NotePreview[]): NotePreview[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  return recentIds
    .map((id) => byId.get(id))
    .filter((note): note is NotePreview => note !== undefined);
}
