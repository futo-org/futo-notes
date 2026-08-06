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
    runWhenPointerIdle(run);
    expect(run).not.toHaveBeenCalled();

    fire('pointerup');
    expect(run).not.toHaveBeenCalled();

    fire('click');
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
    fire('pointercancel');

    fire('pointerdown');
    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();

    fire('pointerup');
    fire('click');
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledOnce();
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

  it('recovers when a release is never delivered and the window loses focus', () => {
    const run = vi.fn();
    fire('pointerdown');
    runWhenPointerIdle(run);
    expect(run).not.toHaveBeenCalled();

    fire('blur');
    expect(run).toHaveBeenCalledOnce();

    const later = vi.fn();
    runWhenPointerIdle(later);
    expect(later).toHaveBeenCalledOnce();
  });
});

describe('runWhenPointerIdle during a drag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetPointerGestureForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetPointerGestureForTest();
  });

  it('holds the work for the whole drag, not just to the pointercancel', () => {
    const run = vi.fn();
    fire('pointerdown');
    runWhenPointerIdle(run);

    fire('dragstart');
    fire('pointercancel');
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();

    fire('drop');
    fire('dragend');
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps waiting after a drag ends while another pointer is still held', () => {
    const run = vi.fn();
    fire('pointerdown');
    runWhenPointerIdle(run);
    fire('pointerdown');

    fire('dragstart');
    fire('pointercancel');
    fire('dragend');
    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();

    fire('pointerup');
    fire('click');
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not let a fallback armed by an earlier gesture drain into a new drag', () => {
    const run = vi.fn();
    fire('pointerdown');
    runWhenPointerIdle(run);

    fire('dragstart');
    fire('pointercancel');
    fire('dragend');

    vi.advanceTimersByTime(50);
    fire('pointerdown');
    fire('dragstart');
    fire('pointercancel');
    vi.advanceTimersByTime(50);
    expect(run).not.toHaveBeenCalled();

    fire('dragend');
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not drain on a window blur that arrives mid-drag', () => {
    const run = vi.fn();
    fire('pointerdown');
    runWhenPointerIdle(run);
    fire('dragstart');
    fire('pointercancel');

    fire('blur');
    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();

    fire('dragend');
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledOnce();
  });

  it('recovers on the next press when dragend is never delivered', () => {
    const run = vi.fn();
    fire('pointerdown');
    runWhenPointerIdle(run);
    fire('dragstart');
    fire('pointercancel');

    fire('pointerdown');
    fire('pointerup');
    fire('click');
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledOnce();
  });
});
