import { getNoteById, getSaveIdentityChange } from './notes.svelte';

export interface NoteActionPick {
  resolve: () => string | null;
}

/**
 * Binds a move or delete to the note the user picked, across the rename its
 * pending save may commit. Reading the live active note instead would follow a
 * click made during that save, and a delete resolved that way destroys a note
 * the user never picked — so an unresolvable pick has no target at all.
 */
export function pickNoteForAction(pickedId: string | null): NoteActionPick {
  return {
    resolve(): string | null {
      if (pickedId !== null && getNoteById(pickedId)) return pickedId;
      const change = getSaveIdentityChange();
      if (!change || change.from !== pickedId) return null;
      return getNoteById(change.to) ? change.to : null;
    },
  };
}
