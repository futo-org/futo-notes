import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MACOS_TRAFFIC_LIGHTS_WIDTH } from './configureWindowChrome';

const CONFIGS = [
  'apps/tauri/src-tauri/tauri.conf.json',
  'apps/tauri/src-tauri/tauri.dev.conf.json',
  'apps/tauri/src-tauri/tauri.macos.conf.json',
];

// Every window config, including the platform overlays that REPLACE the base
// `windows` array rather than merging into it.
const ALL_WINDOW_CONFIGS = [...CONFIGS, 'apps/tauri/src-tauri/tauri.windows.conf.json'];

const BUTTON_SIZE = 14;
const BUTTON_GAP = 9;

function trafficLightPosition(file: string): { x: number; y: number } {
  const config = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
  const window = config.app?.windows?.[0];
  expect(window, `${file} declares no window`).toBeTruthy();
  const position = window.trafficLightPosition;
  expect(position, `${file} declares no trafficLightPosition`).toBeTruthy();
  return position;
}

describe('macOS traffic-light geometry', () => {
  it('is identical across every window config', () => {
    const [base, ...overlays] = CONFIGS.map(trafficLightPosition);
    for (const [index, overlay] of overlays.entries()) {
      expect(overlay, `${CONFIGS[index + 1]} disagrees with ${CONFIGS[0]}`).toEqual(base);
    }
  });

  it('matches the leading gutter this module reserves', () => {
    const { x } = trafficLightPosition(CONFIGS[0]);
    const lightsEnd = x + 3 * BUTTON_SIZE + 2 * BUTTON_GAP;
    expect(MACOS_TRAFFIC_LIGHTS_WIDTH).toBe(`${lightsEnd}px`);
  });
});

// A webview paints opaque white until its first frame, so the window is created
// hidden and revealed once the shell has painted (window_reveal.rs +
// revealAppWindow). A platform overlay REPLACES the base `windows` array, so an
// overlay that forgets the flag silently restores the white launch flash on
// exactly that platform.
describe('hidden-until-painted window', () => {
  it('is declared by every window config', () => {
    for (const file of ALL_WINDOW_CONFIGS) {
      const config = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
      const window = config.app?.windows?.[0];
      expect(window, `${file} declares no window`).toBeTruthy();
      expect(window.visible, `${file} does not start hidden`).toBe(false);
    }
  });
});
