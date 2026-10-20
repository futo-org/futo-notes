// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStackedView } from './__fixtures__/stackedBlocksView';
import { BlockDragSession } from './blockDragSession';
import { DEFAULT_LONG_PRESS_MS, MobileBlockDndView } from './mobileBlockDnd';
import { makeView, pointerEvent, makeOptions } from './__fixtures__/mobileBlockDndView';

describe('MobileBlockDndView — one session move per frame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A touch digitizer reports more moves than there are frames (WKWebView
  // delivers every one), and each session move reads geometry and redraws the
  // preview. Only the last position of a frame is worth drawing.
  it('coalesces the moves of one frame into one session move, at the last position', () => {
    const moveSpy = vi.spyOn(BlockDragSession.prototype, 'move');
    const { view, dom, pointA } = makeView(/* hasFocus */ false);
    const { options } = makeOptions();
    const pluginView = new MobileBlockDndView(view, options);
    const moveTo = (dy: number) =>
      document.dispatchEvent(
        pointerEvent('pointermove', { clientX: pointA.x, clientY: pointA.y + dy }),
      );

    dom.dispatchEvent(pointerEvent('pointerdown', { clientX: pointA.x, clientY: pointA.y }));
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS); // lift
    moveTo(5);
    moveTo(10);
    moveTo(15);
    expect(moveSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20); // one frame
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenLastCalledWith(pointA.x, pointA.y + 15);

    // The release takes its own position; the frame it cut short never runs.
    moveTo(20);
    document.dispatchEvent(
      pointerEvent('pointerup', { clientX: pointA.x, clientY: pointA.y + 20 }),
    );
    vi.advanceTimersByTime(20);
    expect(moveSpy).toHaveBeenCalledTimes(1);

    pluginView.destroy();
    moveSpy.mockRestore();
  });

  // The boundary haptic is a fact about the gap the drawn frame shows: one
  // tick per frame that lands in a new gap, none for a gap the finger entered
  // and left again between two frames.
  it('ticks the boundary haptic once per new gap a frame lands in', () => {
    const fixture = makeStackedView(['a', 'b', 'c']);
    const { options, onHaptic } = makeOptions();
    const pluginView = new MobileBlockDndView(fixture.view, options);
    const at = (y: number) => ({ clientX: 150, clientY: y });
    const moves = () => onHaptic.mock.calls.filter(([kind]) => kind === 'move').length;

    fixture.dom.dispatchEvent(pointerEvent('pointerdown', at(fixture.upperHalf(0))));
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS); // lift
    expect(onHaptic).toHaveBeenCalledWith('lift');

    // Into the b/c gap and back to the source within one frame: nothing new drawn.
    document.dispatchEvent(pointerEvent('pointermove', at(fixture.lowerHalf(1))));
    document.dispatchEvent(pointerEvent('pointermove', at(fixture.upperHalf(0))));
    vi.advanceTimersByTime(20);
    expect(moves()).toBe(0);

    // Into the b/c gap, then wandering inside it across frames: one tick.
    document.dispatchEvent(pointerEvent('pointermove', at(fixture.lowerHalf(1))));
    vi.advanceTimersByTime(20);
    document.dispatchEvent(pointerEvent('pointermove', at(fixture.upperHalf(2))));
    vi.advanceTimersByTime(20);
    expect(moves()).toBe(1);

    // On to the end of the document: the second tick.
    document.dispatchEvent(pointerEvent('pointermove', at(fixture.lowerHalf(2))));
    vi.advanceTimersByTime(20);
    expect(moves()).toBe(2);

    document.dispatchEvent(pointerEvent('pointerup', at(fixture.lowerHalf(2))));
    expect(fixture.order()).toEqual(['b', 'c', 'a']);
    pluginView.destroy();
    fixture.destroy();
  });
});
