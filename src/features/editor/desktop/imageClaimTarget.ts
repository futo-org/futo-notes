/* Where a pasted, dropped or picked image lands once its file is saved: the engine's claimed
 * insertion (portable-core/images.md). The claim is taken when the paste or drop happens, or
 * as the picker opens, and names that
 * note's session, so edits made while the file saves keep it (the image lands at the caret as
 * it is then), while another note, or the same note opened again, makes the engine refuse it.
 * An image saved while an input method composes lands once the composition ends. A saved file
 * nothing points at is deleted (docs/spec/editor/images.md). */
import type { CompleteImageInsert, ImageInsertTarget } from '../imageInsertTarget';
import type { EditorView } from './view';

/** What the target does with the vault: removes a saved image that did not land. */
export interface ImageClaimTargetOptions {
  view: EditorView;
  discard: (filename: string) => Promise<void>;
}

/** Whether `filename` landed in the note the view shows now, under `claim`. */
function insertClaimedImage(view: EditorView, claim: bigint, filename: string): boolean {
  let landed = false;
  view.selection.sync();
  view.run((engine) => {
    const applied = engine.insertImage(claim, filename);
    landed = applied !== null;
    return applied;
  });
  return landed;
}

/** Run `insert` now, or once an input method's composition has ended (the engine takes no
 *  image while one is open): the view commits the composed text first, being the first to
 *  hear its end. */
function afterComposition(view: EditorView, insert: () => void): void {
  if (!view.isComposing()) return insert();
  view.dom.addEventListener('compositionend', () => afterComposition(view, insert), {
    once: true,
  });
}

export function createImageClaimTarget(options: ImageClaimTargetOptions): ImageInsertTarget {
  const { view, discard } = options;
  return {
    begin(): CompleteImageInsert {
      const claim = view.currentEngine()?.imageClaim() ?? null;
      return (filename: string): void =>
        afterComposition(view, () => {
          if (claim !== null && insertClaimedImage(view, claim, filename)) return;
          void discard(filename).catch((error: unknown) =>
            console.warn('abandoned image not removed:', error),
          );
        });
    },
  };
}
