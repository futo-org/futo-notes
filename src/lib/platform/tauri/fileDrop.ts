import { getCurrentWebview } from '@tauri-apps/api/webview';

import type { FileDropEvent } from '../types';

/**
 * OS file drops, as the Tauri window reports them.
 *
 * This used to be the ONLY way Linux ever saw a drop: wry's WebKitGTK
 * drag-drop handler claimed a file-URI drop and turned it into this event,
 * while an HTML5 `drop` listener inside the page fired with an empty `files`
 * list. That handler is now off on every desktop platform — macOS, Windows,
 * and (since QA #017, 2026-09-11) Linux too all set `dragDropEnabled: false`,
 * because on a native-Wayland compositor wry's GTK relay never fired a real
 * drop at all. So this event is not expected to fire on any platform anymore;
 * it stays wired as a defensive fallback in case some distro/compositor
 * combination still runs wry's native layer. See `../dragDropConfig.test.ts`
 * for the config gate; the editor listens to both this and the HTML5 `drop`
 * path and takes whichever arrives.
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
