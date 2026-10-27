import { describe, expect, it } from 'vitest';

import {
  createAndroidDevice,
  statusBarTopInsetFromDump,
  tapTargetNeedsMoveDown,
  tapTargetContentDownSwipe,
} from './device.mjs';

describe('Android safe labeled taps', () => {
  it('keeps default matching exact when only a composite prefix is visible', async () => {
    const taps = [];
    const adb = {
      dumpUiXml: () => '<node text="Target&#10;body" bounds="[20,200][80,220]" />',
      tapPoint: (...args) => taps.push(args),
    };
    const device = createAndroidDevice({ adbClientFactory: () => adb, pollIntervalMs: 0 });
    await expect(device.tap('Target', { scroll: false, timeoutMs: 25 })).rejects.toThrow(
      'timed out',
    );
    expect(taps).toEqual([]);
  });

  it('reuses an explicit matcher when an inset swipe changes the composite label', async () => {
    let centerY = 11;
    let preview = 'before';
    const taps = [];
    const swipes = [];
    const adb = {
      shell: (command) =>
        command === 'wm size'
          ? 'Physical size: 720x1600'
          : 'InsetsSource type=statusBars frame=[0,0][720,48] visible=true',
      dumpUiXml: () =>
        `<node text="Target&#10;${preview}" bounds="[20,${centerY - 10}][80,${centerY + 10}]" />`,
      swipe: (...args) => {
        swipes.push(args);
        centerY = 92;
        preview = 'after';
      },
      tapPoint: (...args) => taps.push(args),
    };
    const device = createAndroidDevice({ adbClientFactory: () => adb, pollIntervalMs: 0 });
    const result = await device.tap('Target', {
      timeoutMs: 25,
      matchLabel: (label) => label.startsWith('Target\n'),
    });
    expect(swipes).toEqual([[360, 480, 360, 1200]]);
    expect(taps).toEqual([[50, 92]]);
    expect(result.label).toBe('Target\nafter');
  });
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

// Gesture navigation can ignore injected Back key events. Exercise the same
// device interface used by the CLI against controlled navigation state.
describe('Android native navigation and field input', () => {
  it('uses a left-edge swipe for Back on a gesture-navigation device', () => {
    const events = [];
    const adb = {
      shell: (command) => (command === 'wm size' ? 'Physical size: 720x1600' : '2'),
      swipe: (...args) => events.push(['swipe', ...args]),
      keyevent: (code) => events.push(['key', code]),
    };
    const device = createAndroidDevice({ adbClientFactory: () => adb });
    device.back();
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe('swipe');
    expect(events[0][1]).toBeLessThan(5);
    expect(events[0][3]).toBeGreaterThan(400);
  });

  it('keeps key Back on a button-navigation device', () => {
    const events = [];
    const adb = {
      shell: () => '0',
      keyevent: (code) => events.push(code),
    };
    createAndroidDevice({ adbClientFactory: () => adb }).back();
    expect(events).toEqual([4]);
  });

  it('uses explicit replacement when asked, and appends otherwise', () => {
    let field = 'http://10.0.2.2:3005';
    const adb = {
      typeText: (text) => {
        field += text;
      },
      replaceText: (text) => {
        field = text;
      },
    };
    const device = createAndroidDevice({ adbClientFactory: () => adb });
    device.typeText('https://10.0.2.2:8445', { replace: true });
    expect(field).toBe('https://10.0.2.2:8445');
    device.typeText('/api');
    expect(field).toBe('https://10.0.2.2:8445/api');
  });
});

describe('Back navigation geometry and refusal', () => {
  it('uses the effective override size instead of a larger physical panel', () => {
    const swipes = [];
    const adb = {
      shell: (command) =>
        command === 'wm size' ? 'Physical size: 1080x1920\nOverride size: 720x1600' : '2',
      swipe: (...args) => swipes.push(args),
    };
    createAndroidDevice({ adbClientFactory: () => adb }).back();
    expect(swipes[0][2]).toBeLessThanOrEqual(720);
  });

  it('uses the overlay resource when the secure navigation setting is absent', () => {
    const keys = [];
    const adb = {
      shell: (command) => (command.includes('settings get') ? 'null' : '0'),
      keyevent: (code) => keys.push(code),
    };
    createAndroidDevice({ adbClientFactory: () => adb }).back();
    expect(keys).toEqual([4]);
  });

  it('refuses Back when the navigation mode cannot be measured', () => {
    const events = [];
    const adb = {
      shell: () => '',
      keyevent: (code) => events.push(code),
      swipe: () => events.push('swipe'),
    };
    expect(() => createAndroidDevice({ adbClientFactory: () => adb }).back()).toThrow(
      'cannot determine',
    );
    expect(events).toEqual([]);
  });
});
