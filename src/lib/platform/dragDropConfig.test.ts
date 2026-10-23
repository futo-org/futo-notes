import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_TAURI = resolve(ROOT, 'apps/tauri/src-tauri');

function readConf(file: string) {
  return JSON.parse(readFileSync(resolve(SRC_TAURI, file), 'utf8'));
}

function windowConf(file: string) {
  return readConf(file).app?.windows?.[0];
}

// `dragDropEnabled` exists to stop a NATIVE drag-drop layer from eating the
// sidebar's internal HTML5 dragover/drop, and every desktop backend needs it off:
//
//   Windows (wry webview2/drag_drop.rs)  RegisterDragDrop(hwnd, ...) replaces the
//                                        HWND's OLE drop target. Eats internal drags.
//   macOS   (wry wkwebview/drag_drop.rs) overrides draggingEntered/draggingUpdated/
//                                        performDragOperation. Eats internal drags.
//   Linux   (wry webkitgtk/drag_drop.rs) only connects GTK signal handlers, but on a
//                                        native-Wayland compositor (QA #017,
//                                        Hyprland/wlroots; tauri-apps/tauri#11282,
//                                        tauri-apps/wry#1256) its relay never fires
//                                        `drag-drop`, so an external file drop did
//                                        nothing in a packaged build.
//
// With the flag off, WebKitGTK's and the other webviews' own HTML5 drop delivers
// `dataTransfer.files`, and internal sidebar/tab dragging is untouched.
describe('drag & drop is left to the webview on every platform (QA #017)', () => {
  it('the base window disables the native drag-drop layer', () => {
    expect(windowConf('tauri.conf.json')?.dragDropEnabled).toBe(false);
  });

  // Every other config merges over the base (Tauri: RFC 7396 JSON Merge Patch),
  // and an array is not an object, so a `windows` array in one would REPLACE the
  // base window outright: a key it forgot to restate silently reverts there,
  // which is how Linux regressed into QA #017 when each platform had its own
  // window block. The base window is the only window block.
  it('no other config replaces the base window', () => {
    const overlays = readdirSync(SRC_TAURI).filter((file) => /^tauri\..+\.conf\.json$/.test(file));
    expect(overlays).toContain('tauri.dev.conf.json');
    for (const file of overlays) {
      expect(readConf(file).app?.windows, file).toBeUndefined();
    }
  });
});
