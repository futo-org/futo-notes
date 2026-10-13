import { describe, expect, it } from 'vitest';

import { createInteractionHold } from './interactionHold';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createInteractionHold', () => {
  it('holds for the settle window after an interaction, then lifts', () => {
    const c = clock();
    const hold = createInteractionHold({ settleMs: 150, maxHoldMs: 1000, now: c.now });

    expect(hold.isHeld()).toBe(false);
    hold.touch();
    expect(hold.isHeld()).toBe(true);
    c.advance(149);
    expect(hold.isHeld()).toBe(true);
    c.advance(1);
    expect(hold.isHeld()).toBe(false);
  });

  it('re-arms the settle window on every interaction', () => {
    const c = clock();
    const hold = createInteractionHold({ settleMs: 150, maxHoldMs: 1000, now: c.now });

    hold.touch();
    c.advance(100);
    hold.touch();
    c.advance(100);
    expect(hold.isHeld()).toBe(true);
    c.advance(50);
    expect(hold.isHeld()).toBe(false);
  });

  it('stops holding once an unbroken run of events reaches the max hold', () => {
    const c = clock();
    const hold = createInteractionHold({ settleMs: 150, maxHoldMs: 1000, now: c.now });

    for (let i = 0; i < 20; i += 1) {
      hold.touch();
      c.advance(50);
    }
    // 1,000 ms in: exhausted, and still being touched.
    expect(hold.isHeld()).toBe(false);
    hold.touch();
    expect(hold.isHeld()).toBe(false);
  });

  it('holds again only after the events pause for a settle window', () => {
    const c = clock();
    const hold = createInteractionHold({ settleMs: 150, maxHoldMs: 1000, now: c.now });

    for (let i = 0; i < 21; i += 1) {
      hold.touch();
      c.advance(50);
    }
    expect(hold.isHeld()).toBe(false);
    c.advance(150);
    hold.touch();
    expect(hold.isHeld()).toBe(true);
  });

  it('watches pointer, focus and key events on the attached target, until detached', () => {
    const c = clock();
    const hold = createInteractionHold({ settleMs: 150, maxHoldMs: 1000, now: c.now });
    const target = new EventTarget();
    const detach = hold.attach(target);

    for (const type of ['pointerdown', 'focusin', 'keydown']) {
      c.advance(1000);
      expect(hold.isHeld()).toBe(false);
      target.dispatchEvent(new Event(type));
      expect(hold.isHeld()).toBe(true);
    }

    detach();
    c.advance(1000);
    target.dispatchEvent(new Event('pointerdown'));
    expect(hold.isHeld()).toBe(false);
  });
});
