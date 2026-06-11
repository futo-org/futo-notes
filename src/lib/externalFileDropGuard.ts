/**
 * Block the webview's default handling of EXTERNAL file drags (from the OS
 * file manager): without this, dropping a file anywhere in the window
 * navigates the webview to that file, killing the app shell.
 *
 * Needed because Windows builds set `dragDropEnabled: false`
 * (tauri.windows.conf.json) so HTML5 drag events work at all on WebView2 —
 * wry's native drag-drop handler swallows them otherwise, which broke
 * dragging notes into folders. With wry no longer intercepting OS drops,
 * they reach the DOM and must be neutralized here. On macOS/Linux wry still
 * intercepts OS drops, so these listeners simply never see a `Files` drag.
 *
 * Internal note/folder drags use custom MIME types (see FolderTreeView), so
 * their `dataTransfer.types` never includes `Files` and they pass through
 * untouched.
 */

function isExternalFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // `types` is a frozen array in modern engines but a DOMStringList in older
  // WebKit — handle both.
  return Array.prototype.includes.call(types, 'Files');
}

export function handleWindowDragOver(e: DragEvent): void {
  if (!isExternalFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
}

export function handleWindowDrop(e: DragEvent): void {
  if (!isExternalFileDrag(e)) return;
  e.preventDefault();
}

/** Install the guard on `window`. Synchronous, no await — safe during shell render. */
export function installExternalFileDropGuard(): void {
  window.addEventListener('dragover', handleWindowDragOver);
  window.addEventListener('drop', handleWindowDrop);
}
