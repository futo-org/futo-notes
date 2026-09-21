import { describe, expect, it } from 'vitest';

import { tapTurnPayout } from './supporterCoin';

/** One click's worth of turn. */
const TURN = Math.PI * 2;
/** A 60 Hz frame. */
const FRAME = 1 / 60;

/// Runs the payout to completion and reports what was delivered and how long it
/// took, which is the only thing the queue promises: every radian a click owes
/// the coin is turned, and the debt does reach zero.
function payOff(debt: number, addAfterFrames: Map<number, number> = new Map()) {
  let owed = debt;
  let turned = 0;
  let frames = 0;
  // A ceiling, so a payout that never terminates fails as a test rather than
  // hanging the suite.
  while (owed > 0 && frames < 6000) {
    const extra = addAfterFrames.get(frames);
    if (extra !== undefined) owed += extra;
    const paid = tapTurnPayout(owed, FRAME);
    owed -= paid;
    turned += paid;
    frames += 1;
  }
  return { turned, frames, owed };
}

describe('the coin’s click queue', () => {
  it('turns exactly once for one click, and finishes', () => {
    const { turned, frames, owed } = payOff(TURN);

    expect(turned).toBeCloseTo(TURN, 10);
    expect(owed).toBe(0);
    // Just over a second: a flourish that coasts, not a wind-down.
    expect(frames).toBeLessThan(80);
  });

  // The whole point of the change (@justin 2026-09-18): the old model held a
  // phase into one turn and reset it on every click, so a burst of ten clicks
  // delivered one turn and dropped nine.
  it('turns ten times for ten clicks', () => {
    const { turned, owed } = payOff(TURN * 10);

    expect(turned).toBeCloseTo(TURN * 10, 10);
    expect(owed).toBe(0);
  });

  it('keeps a click that lands while an earlier one is still being paid', () => {
    const { turned, owed } = payOff(TURN, new Map([[3, TURN]]));

    expect(turned).toBeCloseTo(TURN * 2, 10);
    expect(owed).toBe(0);
  });

  // Ten turns owed would open at 188 rad/s uncapped, which is three turns in a
  // single 60 Hz frame: a coin that reads as stationary or strobing.
  it('never pays out fast enough to strobe, however much is owed', () => {
    const perFrame = tapTurnPayout(TURN * 50, FRAME);

    expect(perFrame).toBeLessThan(TURN / 2);
  });

  it('pays nothing when nothing is owed', () => {
    expect(tapTurnPayout(0, FRAME)).toBe(0);
  });
});
