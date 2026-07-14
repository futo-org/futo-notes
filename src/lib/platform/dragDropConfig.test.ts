import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
    expect(windowConf('tauri.dev.conf.json')?.dragDropEnabled).toBe(false);
  });

  it('macOS config preserves the traffic-light window chrome (array is replaced, not merged)', () => {
    const w = windowConf('tauri.macos.conf.json');
    expect(w?.titleBarStyle).toBe('Overlay');
    expect(w?.hiddenTitle).toBe(true);
    expect(w?.trafficLightPosition).toEqual({ x: 19, y: 20 });
  });
});
