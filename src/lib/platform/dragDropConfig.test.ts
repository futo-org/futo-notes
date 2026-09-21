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

  it('Linux build config disables native drag-drop too', () => {
    expect(windowConf('tauri.linux.conf.json')?.dragDropEnabled).toBe(false);
  });

  it('dev config disables it too, so the dev build mirrors macOS/Windows/Linux', () => {
    expect(windowConf('tauri.dev.conf.json')?.dragDropEnabled).toBe(false);
  });

  it('macOS config preserves the traffic-light window chrome (array is replaced, not merged)', () => {
    const w = windowConf('tauri.macos.conf.json');
    expect(w?.titleBarStyle).toBe('Overlay');
    expect(w?.hiddenTitle).toBe(true);
    expect(w?.trafficLightPosition).toEqual(windowConf('tauri.conf.json')?.trafficLightPosition);
  });
});

// Linux USED to be the platform with no overlay file, leaving `dragDropEnabled`
// at its default (true) deliberately: the flag exists to stop a NATIVE
// drag-drop layer from eating the sidebar's internal HTML5 dragover/drop, and
// of the three backends only two install one that does that —
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
// — and Linux's own X11 GTK relay for an external file-URI drop had been
// verified working (Fedora 44, WebKitGTK 2.52.5, dragDropEnabled at its
// default): dragging a note onto a folder fired dragstart/dragenter/dragover/
// drop and moved the file on disk, and a real file drag from a file manager
// landed too. That verification pre-dates QA #017 (2026-09-11): on a
// NATIVE-WAYLAND compositor (confirmed Hyprland/wlroots; matches upstream
// tauri-apps/tauri#11282, tauri-apps/wry#1256) wry's GTK-signal relay never
// fires the `drag-drop` signal at all, so an external file drop silently did
// nothing in a PACKAGED build — invisible from `just tauri-dev`, which has
// always forced the flag off. Disabling the flag on Linux too means wry never
// connects that relay, so WebKitGTK's own default drag-and-drop delivers a
// real HTML5 `drop` DOM event with `dataTransfer.files` on every compositor,
// exactly as it already does with the flag off in dev builds — where internal
// sidebar/tab dragging (pure in-page HTML5 DnD, never touched by wry's signal
// handlers either way) has kept working the whole time.
describe('sidebar drag & drop: Linux now disables the native layer too (QA #017)', () => {
  it('the base config leaves dragDropEnabled unset (platform overlays own the flag)', () => {
    expect(windowConf('tauri.conf.json')).not.toHaveProperty('dragDropEnabled');
  });

  it('has a Linux overlay now, so a packaged Linux build gets the flag disabled', () => {
    expect(exists('tauri.linux.conf.json')).toBe(true);
  });
});

// The regression gate QA #017 asked for: no future platform/dev overlay may
// reintroduce a native drag-drop layer by omission. Every overlay that
// defines a window MUST restate `dragDropEnabled: false` explicitly — an
// overlay that defines a window but leaves the key out inherits wry's default
// (true) per Tauri's array-replaces-array merge (see the describe block
// below), which is exactly how Linux regressed into #017 in the first place.
describe('regression gate: no platform config may leave drag-drop to a native layer', () => {
  it.each([
    'tauri.macos.conf.json',
    'tauri.windows.conf.json',
    'tauri.linux.conf.json',
    'tauri.dev.conf.json',
  ])('%s explicitly disables dragDropEnabled', (file) => {
    expect(windowConf(file)?.dragDropEnabled, file).toBe(false);
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
});
