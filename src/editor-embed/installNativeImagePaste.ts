import type { EditorView } from '@codemirror/view';

import { hasNativeBridgeHost } from '@futo-notes/editor';

import {
  createBridgeImagePasteSink,
  createImagePasteHandler,
} from '$features/editor/imagePasteSink';

/**
 * Clipboard image paste for the CodeMirror editor inside a native shell
 * (`editor.html?cm`). The Milkdown editor installs its own paste through
 * ProseMirror's `handlePaste` prop and needs nothing here.
 *
 * Both share the classification and the bridge sink, so what counts as an image
 * paste and what goes over the wire cannot drift between the two engines
 * (`imagePaste.ts` `classifyImagePaste`, `imagePasteSink.ts`). What is
 * CodeMirror-specific is only this plumbing: a capturing document listener,
 * because CodeMirror's own paste handling has to be cut off before it runs.
 *
 * Nothing is inserted here — the host writes the file into the vault and calls
 * `FutoEditor.insertImage(filename)` back.
 */
export function installNativeImagePaste(getView: () => EditorView | null): () => void {
  /* No `insertImage`: the bridge sink always resolves to null because the host
   * writes the file and calls `FutoEditor.insertImage(filename)` back. */
  const handleImagePaste = createImagePasteHandler({ sink: createBridgeImagePasteSink() });

  function handlePaste(event: ClipboardEvent): void {
    if (!hasNativeBridgeHost()) return;
    const view = getView();
    if (!view) return;

    const target = event.target as Node | null;
    const isInsideEditor =
      (target && view.contentDOM.contains(target)) ||
      view.contentDOM.contains(document.activeElement);
    if (!isInsideEditor) return;

    // `createImagePasteHandler` already called preventDefault when it claimed
    // the paste; CodeMirror's own handler still has to be cut off.
    if (handleImagePaste(event)) event.stopImmediatePropagation();
  }

  document.addEventListener('paste', handlePaste, true);
  return () => document.removeEventListener('paste', handlePaste, true);
}
