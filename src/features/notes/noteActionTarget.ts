import { getNoteById } from './notes.svelte';

let lastSaveIdentityChange: { from: string | null; to: string } | null = null;
let identityChangeSeq = 0;

/** The id a save gave the note it wrote, when it differs from the one the
 * session held: the mint of a first save, or the move a title edit performed. */
export function recordSaveIdentityChange(from: string | null, to: string): void {
  lastSaveIdentityChange = { from, to };
  identityChangeSeq += 1;
}

export interface NoteActionPick {
  /** The note to act on now, or null when it can no longer be identified. */
  resolve: () => string | null;
}

/**
 * Binds a move or delete to the note the user picked.
 *
 * The flush these actions run first can change the picked note's id, so the id
 * alone stops naming it. Re-reading the active note recovers that, but it
 * equally follows a click elsewhere during the flush — and a delete resolved
 * that way destroys a note the user never picked. So the pick is translated
 * only across a save this action's own flush performed; anything else means the
 * note is gone and the action has no target.
 */
export function pickNoteForAction(pickedId: string | null): NoteActionPick {
  const pickedSeq = identityChangeSeq;
  return {
    resolve(): string | null {
      if (pickedId !== null && getNoteById(pickedId)) return pickedId;
      if (identityChangeSeq === pickedSeq) return null;
      const change = lastSaveIdentityChange;
      if (!change || change.from !== pickedId) return null;
      return getNoteById(change.to) ? change.to : null;
    },
  };
}
