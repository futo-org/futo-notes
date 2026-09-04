import { getCurrentWebview } from '@tauri-apps/api/webview';

import type { FileDropEvent } from '../types';

/**
 * OS file drops, as the Tauri window reports them.
 *
 * This exists because on LINUX the webview never sees the drop. wry's WebKitGTK
 * drag-drop handler claims a file-URI drop and turns it into this event, so an
 * HTML5 `drop` listener inside the page fires with an empty `files` list. macOS
 * and Windows are the other way round — both build configs set
 * `dragDropEnabled: false`, which is exactly the flag that stops wry installing
 * a native drop target there, so those two deliver a real HTML5 drop and this
 * event never fires. See `../dragDropConfig.test.ts` for why the flag differs
 * per platform; the editor listens to both paths and takes whichever arrives.
 *
 * `position` is PHYSICAL (device pixels). Everything that resolves a point back
 * to a document position — `posAtCoords` — speaks CSS pixels, so the conversion
 * belongs here rather than at each consumer.
 */
export function subscribeToFileDrop(handler: (event: FileDropEvent) => void): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== 'drop') return;
    const ratio = window.devicePixelRatio || 1;
    handler({
      paths: event.payload.paths,
      x: event.payload.position.x / ratio,
      y: event.payload.position.y / ratio,
    });
  });
}
