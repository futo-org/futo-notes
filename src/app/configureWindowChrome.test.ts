import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MACOS_TRAFFIC_LIGHTS_WIDTH } from './configureWindowChrome';

// The one window block (src/lib/platform/dragDropConfig.test.ts holds every
// other config to not replacing it).
const baseWindow = JSON.parse(
  readFileSync(resolve(process.cwd(), 'apps/tauri/src-tauri/tauri.conf.json'), 'utf8'),
).app.windows[0];

const BUTTON_SIZE = 14;
const BUTTON_GAP = 9;

describe('macOS traffic-light geometry', () => {
  it('draws the traffic lights over a hidden title bar', () => {
    expect(baseWindow).toMatchObject({ titleBarStyle: 'Overlay', hiddenTitle: true });
  });

  it('matches the leading gutter this module reserves', () => {
    const { x } = baseWindow.trafficLightPosition;
    const lightsEnd = x + 3 * BUTTON_SIZE + 2 * BUTTON_GAP;
    expect(MACOS_TRAFFIC_LIGHTS_WIDTH).toBe(`${lightsEnd}px`);
  });
});

// A webview paints opaque white until its first frame, so the window is created
// hidden and revealed once the shell has painted (window_reveal.rs +
// revealAppWindow).
describe('hidden-until-painted window', () => {
  it('starts hidden', () => {
    expect(baseWindow.visible).toBe(false);
  });
});
