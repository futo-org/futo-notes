import { describe, it, expect } from 'vitest';
import { isInjectedReversal } from './scrollJumpGuard';

// Guards the decision that drives the mobile scroll-jump suppressor. A CM6
// mid-scroll anchor correction = a large reversal against the scroll direction
// while actively scrolling; everything else must pass through untouched.
describe('isInjectedReversal', () => {
  const THRESH = 30;
  const ACTIVE = 250;

  it('flags a large reversal against the scroll direction while scrolling', () => {
    // Scrolling down (dir=+1), CM injects a -207px backward jump, 16ms after a scroll.
    expect(isInjectedReversal(-207, 1, 16)).toBe(true);
    // Symmetric: scrolling up (dir=-1), a +207 forward jump.
    expect(isInjectedReversal(207, -1, 16)).toBe(true);
  });

  it('ignores normal same-direction motion (momentum)', () => {
    expect(isInjectedReversal(120, 1, 16)).toBe(false); // fast downward frame
    expect(isInjectedReversal(-120, -1, 16)).toBe(false); // fast upward frame
  });

  it('ignores small reversals (momentum micro-jitter / bounce)', () => {
    expect(isInjectedReversal(-12, 1, 16)).toBe(false);
    expect(isInjectedReversal(27, -1, 16)).toBe(false); // just under threshold
  });

  it('does not act before a scroll direction is established', () => {
    expect(isInjectedReversal(-207, 0, 16)).toBe(false);
  });

  it('does not act when the user is not actively scrolling', () => {
    // A large reversal long after the last scroll event = not a mid-scroll
    // correction (e.g. a programmatic scrollIntoView); leave it alone.
    expect(isInjectedReversal(-207, 1, 400)).toBe(false);
    expect(isInjectedReversal(-207, 1, ACTIVE)).toBe(false); // exactly at window edge
  });

  it('respects the threshold boundary', () => {
    expect(isInjectedReversal(-(THRESH + 1), 1, 16)).toBe(true);
    expect(isInjectedReversal(-THRESH, 1, 16)).toBe(false); // not strictly greater
  });
});
