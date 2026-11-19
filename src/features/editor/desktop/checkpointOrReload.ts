/* A verdict to adopt an outside change into a clean draft (createExternalChangeCoordinator.ts),
 * taken through the host: its checkpoint offers the change, which the note adopts in place
 * (attachedNote.ts `landed`). */
import type { EditorOutcome } from '$lib/platform/tauri/editorHost';

export interface OutsideChangeEditor {
  revision: () => number;
  checkpoint: () => Promise<EditorOutcome>;
  composing: () => boolean;
  reload: () => Promise<void>;
}

/** Reloads only when the checkpoint offered nothing and the draft is as it was: the verdict
 *  read bytes the store does not count as an outside change (a relink's baseline). An offer
 *  was adopted, waits for composition, or (refused) already re-opened the note; a key typed
 *  meanwhile makes the draft the user's. */
export async function checkpointOrReload(editor: OutsideChangeEditor): Promise<void> {
  const revision = editor.revision();
  const outcome = await editor.checkpoint();
  if (outcome.offered !== null || editor.revision() !== revision || editor.composing()) return;
  await editor.reload();
}
