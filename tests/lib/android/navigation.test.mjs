import { describe, expect, it } from 'vitest';

describe('prepared Android Back input', () => {
  it('reads mode and geometry before a time-sensitive action, then sends only its input', async () => {
    const { prepareBack } = await import('./navigation.mjs');
    const events = [];
    const adb = {
      shell: (command) => {
        events.push(['read', command]);
        return command === 'wm size' ? 'Physical size: 720x1600' : '2';
      },
      swipe: (...args) => events.push(['swipe', ...args]),
    };
    const send = prepareBack(adb, { durationMs: 120 });
    expect(events.map((e) => e[0])).toEqual(['read', 'read']);
    events.length = 0;
    send();
    expect(events).toEqual([['swipe', 2, 360, 504, 360, 120]]);
  });
});
