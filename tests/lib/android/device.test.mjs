import { describe, expect, it } from 'vitest';

import {
  createAndroidDevice,
  statusBarTopInsetFromDump,
  tapTargetNeedsMoveDown,
  tapTargetContentDownSwipe,
} from './device.mjs';

describe('Android safe labeled taps', () => {
  it('reads the visible status bar inset from WindowManager geometry', () => {
    const dump =
      'InsetsSource id=dcdd0000 type=statusBars frame=[0,0][720,48] visible=true flags= sideHint=TOP';

    expect(statusBarTopInsetFromDump(dump)).toBe(48);
  });

  it('moves a center under the status bar but leaves a safe center alone', () => {
    expect(tapTargetNeedsMoveDown({ y: 11 }, 48)).toBe(true);
    expect(tapTargetNeedsMoveDown({ y: 52 }, 48)).toBe(true);
    expect(tapTargetNeedsMoveDown({ y: 53 }, 48)).toBe(false);
  });

  it('swipes down so list content moves down away from the status bar', () => {
    expect(tapTargetContentDownSwipe({ width: 720, height: 1600 })).toEqual({
      x: 360,
      startY: 480,
      endY: 1200,
    });
  });

  it('relocates a top-row target before tapping its fresh center exactly once', async () => {
    let centerY = 11;
    const swipes = [];
    const taps = [];
    const uiXml = () =>
      `<hierarchy><node text="Target" clickable="true" bounds="[20,${centerY - 10}][80,${centerY + 10}]" /></hierarchy>`;
    const adb = {
      shell(command) {
        if (command === 'wm size') return 'Physical size: 720x1600';
        if (command === 'dumpsys window displays') {
          return 'InsetsSource type=statusBars frame=[0,0][720,48] visible=true';
        }
        throw new Error(`unexpected shell command: ${command}`);
      },
      dumpUiXml: uiXml,
      swipe(...args) {
        swipes.push(args);
        centerY = 92;
      },
      tapPoint: (...args) => taps.push(args),
    };
    const device = createAndroidDevice({ adbClientFactory: () => adb });

    const tapped = await device.tap('Target', { timeoutMs: 100 });

    expect(swipes).toEqual([[360, 480, 360, 1200]]);
    expect(taps).toEqual([[50, 92]]);
    expect(tapped.y).toBe(92);
  });

  it('keeps ordinary taps working when the inset dump format is unavailable', async () => {
    const taps = [];
    let insetQueries = 0;
    const adb = {
      shell(command) {
        if (command === 'wm size') return 'Physical size: 720x1600';
        if (command === 'dumpsys window displays') insetQueries++;
        return 'unknown platform-specific output';
      },
      dumpUiXml: () =>
        '<hierarchy><node text="Target" clickable="true" bounds="[20,232][80,254]" /></hierarchy>',
      swipe() {},
      tapPoint: (...args) => taps.push(args),
    };
    const device = createAndroidDevice({ adbClientFactory: () => adb });

    const tapped = await device.tap('Target', { timeoutMs: 100 });

    expect(tapped.y).toBe(243);
    expect(taps).toEqual([[50, 243]]);
    expect(insetQueries).toBe(1);
  });

  it('refuses to tap when a top-row target stays under the inset after the swipe', async () => {
    const taps = [];
    let swipes = 0;
    const adb = {
      shell(command) {
        if (command === 'wm size') return 'Physical size: 720x1600';
        if (command === 'dumpsys window displays') {
          return 'InsetsSource type=statusBars frame=[0,0][720,48] visible=true';
        }
        throw new Error(`unexpected shell command: ${command}`);
      },
      dumpUiXml: () =>
        '<hierarchy><node text="Target" clickable="true" bounds="[20,0][80,22]" /></hierarchy>',
      swipe: () => swipes++,
      tapPoint: (...args) => taps.push(args),
    };
    const device = createAndroidDevice({ adbClientFactory: () => adb });

    await expect(device.tap('Target', { timeoutMs: 100 })).rejects.toThrow(
      'refusing to tap "Target" under the status bar',
    );
    expect(swipes).toBe(1);
    expect(taps).toEqual([]);
  });
});
