import type { EditorView } from '@codemirror/view';

import {
  createBridgeImagePasteSink,
  createImagePasteHandler,
} from '$features/editor/milkdown/imagePasteSink';

import { hasNativeHost } from './hostBridge';

/**
 * Clipboard image paste for the CodeMirror editor inside a native shell
 * (`editor.html?cm`). The Milkdown editor installs its own paste through
 * ProseMirror's `handlePaste` prop and needs nothing here.
 *
 * Both share the classification and the bridge sink, so what counts as an image
 * paste and what goes over the wire cannot drift between the two engines
 * (`imagePaste.ts` `classifyImagePaste`, `milkdown/imagePasteSink.ts`). What is
 * CodeMirror-specific is only this plumbing: a capturing document listener,
 * because CodeMirror's own paste handling has to be cut off before it runs.
 *
 * Nothing is inserted here — the host writes the file into the vault and calls
 * `FutoEditor.insertImage(filename)` back.
 */
export function installNativeImagePaste(getView: () => EditorView | null): () => void {
  const handleImagePaste = createImagePasteHandler({
    sink: createBridgeImagePasteSink(),
    insertImage: () => {
      /* The native host inserts, over the bridge. */
    },
  });

  function handlePaste(event: ClipboardEvent): void {
    if (!hasNativeHost()) return;
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
