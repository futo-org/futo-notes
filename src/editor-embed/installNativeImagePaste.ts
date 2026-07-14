import { postToHost } from '@futo-notes/editor';
import type { EditorView } from '@codemirror/view';
import { extFromMime, getImageFile, looksLikeImagePaste } from '$features/editor/imagePaste';
import { hasNativeHost } from './hostBridge';

export function installNativeImagePaste(getView: () => EditorView | null): () => void {
  function handlePaste(event: ClipboardEvent): void {
    if (!hasNativeHost()) return;
    const clipboardData = event.clipboardData;
    const view = getView();
    if (!clipboardData || !view) return;

    const target = event.target as Node | null;
    const isInsideEditor =
      (target && view.contentDOM.contains(target)) ||
      view.contentDOM.contains(document.activeElement);
    if (!isInsideEditor) return;

    const file = getImageFile(clipboardData);
    if (file) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') return;
        const comma = reader.result.indexOf(',');
        const data = comma >= 0 ? reader.result.slice(comma + 1) : reader.result;
        postToHost({ type: 'saveImageData', data, ext: extFromMime(file.type) });
      };
      reader.readAsDataURL(file);
      return;
    }

    if (looksLikeImagePaste(clipboardData)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      postToHost({ type: 'pasteClipboardImage' });
    }
  }

  document.addEventListener('paste', handlePaste, true);
  return () => document.removeEventListener('paste', handlePaste, true);
}
