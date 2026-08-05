import { getNoteById, getSaveIdentityChange } from './notes.svelte';

export interface NoteActionPick {
  /** The note to act on now, or null when it can no longer be identified. */
  resolve: () => string | null;
}

/**
 * Binds a move or delete to the note the user picked.
 *
 * The flush these actions run first can change the picked note's id, so the id
 * alone stops naming it — and the menu the user opened still holds the old one.
 * Re-reading the active note recovers that, but it equally follows a click
 * elsewhere during the flush, and a delete resolved that way destroys a note the
 * user never picked. So the pick is translated only across a save of that same
 * note; anything else means it is gone and the action has no target.
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
