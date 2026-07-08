import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Static guard for the sidebar drag & drop platform story.
 *
 * wry's native drag-drop handler (WebView2 on Windows, WKWebView on macOS)
 * swallows the sidebar's internal HTML5 `dragover`/`drop` unless the window
 * sets `dragDropEnabled: false`. Without it, a dragged note follows the cursor
 * but no folder highlights and the drop never lands (Windows always; macOS
 * repro fixed 2026-07-08). Tauri REPLACES the whole `windows` array on config
 * merge rather than deep-merging, so every conf that declares `windows` must
 * carry the flag itself — a dropped flag silently re-breaks drag & drop.
 *
 * Linux (WebKitGTK) does NOT swallow internal drags and keeps the default on,
 * so there is deliberately no `tauri.linux.conf.json` override here.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_TAURI = resolve(ROOT, 'apps/tauri/src-tauri');

function windowConf(file: string) {
  const conf = JSON.parse(readFileSync(resolve(SRC_TAURI, file), 'utf8'));
  return conf.app?.windows?.[0];
}

describe('sidebar drag & drop: dragDropEnabled is off where wry intercepts', () => {
  it('macOS build config disables native drag-drop', () => {
    expect(windowConf('tauri.macos.conf.json')?.dragDropEnabled).toBe(false);
  });

  it('Windows build config disables native drag-drop', () => {
    expect(windowConf('tauri.windows.conf.json')?.dragDropEnabled).toBe(false);
  });

  it('dev config disables it too, so the dev build mirrors macOS/Windows', () => {
    // tauri.dev.conf.json is applied via `--config` AFTER the auto-merged
    // platform config, and REPLACES the windows array — so it must re-declare
    // the flag or `just tauri-dev` on macOS would silently lose the fix.
    expect(windowConf('tauri.dev.conf.json')?.dragDropEnabled).toBe(false);
  });

  it('macOS config preserves the traffic-light window chrome (array is replaced, not merged)', () => {
    const w = windowConf('tauri.macos.conf.json');
    expect(w?.titleBarStyle).toBe('Overlay');
    expect(w?.hiddenTitle).toBe(true);
    expect(w?.trafficLightPosition).toEqual({ x: 19, y: 20 });
  });
});
