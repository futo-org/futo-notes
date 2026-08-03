// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetPointerGestureForTest, runWhenPointerIdle } from './pointerGesture';

function fire(type: string): void {
  window.dispatchEvent(new Event(type));
}

describe('runWhenPointerIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetPointerGestureForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetPointerGestureForTest();
  });

  it('runs synchronously when no pointer is held', () => {
    const run = vi.fn();
    runWhenPointerIdle(run);
    expect(run).toHaveBeenCalledOnce();
  });

  it('holds the work until after the click the gesture delivers', () => {
    const run = vi.fn();
    fire('pointerdown');
    // The caller is a blur handler, which fires during the press.
    runWhenPointerIdle(run);
    expect(run).not.toHaveBeenCalled();

    fire('pointerup');
    expect(run).not.toHaveBeenCalled();

    fire('click');
    // Still queued: the click's own handlers have to finish first.
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it('still runs when the gesture ends without a click', () => {
    const run = vi.fn();
    fire('pointerdown');
    runWhenPointerIdle(run);

    fire('pointercancel');
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledOnce();
  });

  it('runs the work once when a click lands after the fallback already fired', () => {
    const run = vi.fn();
    fire('pointerdown');
    runWhenPointerIdle(run);
    fire('pointerup');
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledOnce();

    fire('click');
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not run during a press that starts inside the fallback window', () => {
    const run = vi.fn();
    fire('pointerdown');
    runWhenPointerIdle(run);
    fire('pointercancel'); // no click — arms the 100ms fallback

    fire('pointerdown'); // user presses again before it elapses
    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();

    fire('pointerup');
    fire('click');
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it('recovers when a release is never delivered and the window loses focus', () => {
    const run = vi.fn();
    fire('pointerdown');
    runWhenPointerIdle(run);
    // Pointer released outside the window: no pointerup, no pointercancel.
    expect(run).not.toHaveBeenCalled();

    fire('blur');
    expect(run).toHaveBeenCalledOnce();

    // The stuck count is cleared, so the next blur commits immediately.
    const later = vi.fn();
    runWhenPointerIdle(later);
    expect(later).toHaveBeenCalledOnce();
  });

  it('waits for every held pointer before running', () => {
    const run = vi.fn();
    fire('pointerdown');
    fire('pointerdown');
    runWhenPointerIdle(run);

    fire('pointerup');
    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();

    fire('pointerup');
    fire('click');
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledOnce();
  });
});
