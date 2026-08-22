import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_TAURI = resolve(ROOT, 'apps/tauri/src-tauri');

function windowConf(file: string) {
  const conf = JSON.parse(readFileSync(resolve(SRC_TAURI, file), 'utf8'));
  return conf.app?.windows?.[0];
}

function exists(file: string) {
  return existsSync(resolve(SRC_TAURI, file));
}

describe('sidebar drag & drop: dragDropEnabled is off where wry intercepts', () => {
  it('macOS build config disables native drag-drop', () => {
    expect(windowConf('tauri.macos.conf.json')?.dragDropEnabled).toBe(false);
  });

  it('Windows build config disables native drag-drop', () => {
    expect(windowConf('tauri.windows.conf.json')?.dragDropEnabled).toBe(false);
  });

  it('dev config disables it too, so the dev build mirrors macOS/Windows', () => {
    expect(windowConf('tauri.dev.conf.json')?.dragDropEnabled).toBe(false);
  });

  it('macOS config preserves the traffic-light window chrome (array is replaced, not merged)', () => {
    const w = windowConf('tauri.macos.conf.json');
    expect(w?.titleBarStyle).toBe('Overlay');
    expect(w?.hiddenTitle).toBe(true);
    expect(w?.trafficLightPosition).toEqual(windowConf('tauri.conf.json')?.trafficLightPosition);
  });
});

// Linux is the platform with NO overlay file, so the base config IS its config —
// and it deliberately leaves `dragDropEnabled` unset (default: true). This is not
// an oversight to be "fixed" by pushing the flag down into the base config; the
// flag exists to stop a NATIVE drag-drop layer from eating the sidebar's internal
// HTML5 dragover/drop, and only two of the three backends install one:
//
//   Windows (wry webview2/drag_drop.rs)  RegisterDragDrop(hwnd, ...) — replaces the
//                                        HWND's OLE drop target. Eats internal drags.
//   macOS   (wry wkwebview/drag_drop.rs) overrides draggingEntered/draggingUpdated/
//                                        performDragOperation. Eats internal drags.
//   Linux   (wry webkitgtk/drag_drop.rs) only CONNECTS GTK signal handlers, never
//                                        calls drag_dest_set and never alters the
//                                        target list; every handler returns false
//                                        except a file-URI drop. Internal drags are
//                                        untouched.
//
// Verified on the real Linux app (Fedora 44, WebKitGTK 2.52.5, dragDropEnabled at
// its default) with genuine X11 pointer input, not synthetic DOM events: dragging a
// note onto a folder fired dragstart 1 / dragenter 5 / dragover 26 / drop 1 and
// moved the file on disk, and a tab drag reordered the strip. Setting the flag here
// would change Linux behaviour with no bug behind it.
describe('sidebar drag & drop: Linux keeps the native layer ON, deliberately', () => {
  it('the base config leaves dragDropEnabled unset', () => {
    expect(windowConf('tauri.conf.json')).not.toHaveProperty('dragDropEnabled');
  });

  it('has no Linux overlay, so the base config is what a Linux build gets', () => {
    expect(exists('tauri.linux.conf.json')).toBe(false);
  });
});

// Tauri merges every extra config with RFC 7396 JSON Merge Patch (tauri-utils
// config/parse.rs -> json_patch::merge), and an array is not an object, so a
// `windows` array in an overlay REPLACES the base array outright — it does not
// merge element-wise. Anything the overlay does not restate is simply gone, which
// is why each overlay repeats the whole window entry.
describe('platform/dev overlays restate what array replacement would drop', () => {
  it('the dev overlay keeps the prod window geometry', () => {
    const base = windowConf('tauri.conf.json');
    const dev = windowConf('tauri.dev.conf.json');
    expect(dev?.width).toBe(base?.width);
    expect(dev?.height).toBe(base?.height);
    expect(dev?.resizable).toBe(base?.resizable);
  });

  it('every window config starts hidden, so none of them can flash or relaunch invisible', () => {
    for (const file of [
      'tauri.conf.json',
      'tauri.macos.conf.json',
      'tauri.windows.conf.json',
      'tauri.dev.conf.json',
    ]) {
      expect(windowConf(file)?.visible, file).toBe(false);
    }
  });
});
