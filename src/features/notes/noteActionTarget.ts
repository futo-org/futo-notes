import { getNoteById } from './notes.svelte';

/**
 * The note a move or delete should act on, or null when there is none.
 *
 * These actions settle the open note's pending save before they run. Re-reading
 * the active note afterwards is necessary — the flush is what gives an unsaved
 * note its real id, and what renames a note whose title was edited — but a click
 * elsewhere during the flush moves the active note too, and that note is not
 * what the action was started for. So a picked id that still names a note wins
 * over the live one.
 *
 * A picked id that no longer names a note was almost certainly renamed by that
 * flush, and `liveId` is its new name. It could instead have been deleted under
 * us, in which case `liveId` is the wrong note — absence alone cannot tell the
 * two apart. Distinguishing them needs the flush's own `renamed` mapping
 * threaded through to here.
 */
export function noteActionTargetId(pickedId: string | null, liveId: string | null): string | null {
  if (pickedId !== null && getNoteById(pickedId)) return pickedId;
  return liveId;
}
