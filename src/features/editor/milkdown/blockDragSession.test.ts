// @vitest-environment jsdom
/**
 * The shared lifted-block drag (blockDragSession.ts) against a fake view: what
 * it draws, when it ticks, and the one transaction it may commit. The gestures
 * that start it are mobileBlockDnd.test.ts and handleBlockDrag.test.ts; the
 * real thing in a real engine is tests/editor-embed-milkdown.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlockDragSession, blockDragSourceKey } from './blockDragSession';
import { BLOCK_HEIGHT, blockTop, makeStackedView } from './__fixtures__/stackedBlocksView';

const X = 100;

function lift(index: number, fixture: ReturnType<typeof makeStackedView>) {
  const el = fixture.element(index);
  const from = fixture.startOf(index);
  return {
    from,
    to: from + fixture.view.state.doc.nodeAt(from)!.nodeSize,
    dom: el,
    clone: el.cloneNode(true) as HTMLElement,
  };
}

describe('BlockDragSession', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('start dims the source through a decoration, draws the ghost and keeps the document', () => {
    const fixture = makeStackedView(['a', 'b', 'c']);
    const session = new BlockDragSession(fixture.view);

    session.start(lift(0, fixture), X, blockTop(0) + 10);

    expect(session.active).toBe(true);
    expect(fixture.dispatched).toHaveLength(1);
    const meta = fixture.dispatched[0].getMeta(blockDragSourceKey);
    expect(meta.decorationSet.find()).toHaveLength(1);
    expect(fixture.order()).toEqual(['a', 'b', 'c']);
    expect(fixture.dom.querySelectorAll('.futo-mobile-dnd-ghost')).toHaveLength(1);
    session.destroy();
  });

  it('ticks onBoundaryChange once per NEW gap, not while the pointer stays in one', () => {
    const fixture = makeStackedView(['a', 'b', 'c']);
    const onBoundaryChange = vi.fn();
    const session = new BlockDragSession(fixture.view, { onBoundaryChange });
    session.start(lift(0, fixture), X, blockTop(0) + 10);

    session.move(X, fixture.lowerHalf(1)); // the b/c gap
    session.move(X, fixture.upperHalf(2)); // the same gap from the other side
    expect(onBoundaryChange).toHaveBeenCalledTimes(1);

    session.move(X, fixture.lowerHalf(2)); // the end of the document
    expect(onBoundaryChange).toHaveBeenCalledTimes(2);
    session.destroy();
  });

  it('draws no line, and ticks nothing, over the source block’s own boundaries', () => {
    const fixture = makeStackedView(['a', 'b', 'c']);
    const onBoundaryChange = vi.fn();
    const session = new BlockDragSession(fixture.view, { onBoundaryChange });
    session.start(lift(0, fixture), X, blockTop(0) + 10);

    session.move(X, fixture.upperHalf(0));
    session.move(X, fixture.lowerHalf(0));

    expect(onBoundaryChange).not.toHaveBeenCalled();
    const line = document.querySelector('.futo-mobile-dnd-indicator');
    expect(line?.classList.contains('futo-mobile-dnd-indicator--visible') ?? false).toBe(false);
    session.destroy();
  });

  it('finish commits the move as ONE transaction and removes the ghost and line', () => {
    const fixture = makeStackedView(['a', 'b', 'c']);
    const session = new BlockDragSession(fixture.view);
    session.start(lift(0, fixture), X, blockTop(0) + 10);
    session.move(X, fixture.lowerHalf(2));
    const before = fixture.dispatched.length;

    const committed = session.finish(fixture.lowerHalf(2), true);

    expect(committed).toBe(true);
    expect(fixture.order()).toEqual(['b', 'c', 'a']);
    expect(fixture.dispatched.length - before).toBe(1);
    expect(session.active).toBe(false);
    expect(document.querySelector('.futo-mobile-dnd-ghost')).toBeNull();
    expect(document.querySelector('.futo-mobile-dnd-indicator')).toBeNull();
  });

  it('a release back over the source commits nothing — no document change', () => {
    const fixture = makeStackedView(['a', 'b', 'c']);
    const session = new BlockDragSession(fixture.view);
    session.start(lift(0, fixture), X, blockTop(0) + 10);

    const committed = session.finish(blockTop(0) + BLOCK_HEIGHT / 2, true);

    expect(committed).toBe(false);
    expect(fixture.order()).toEqual(['a', 'b', 'c']);
    expect(fixture.dispatched.every((tr) => !tr.docChanged)).toBe(true);
  });

  // The Android WebView floor is Chromium 80 (EditorEngineSupport.kt); the
  // ghost shadow's `CanvasRenderingContext2D.roundRect` is Chromium 99.
  describe('on a canvas without roundRect (an older WebView)', () => {
    /** A recording 2D context with the pre-99 surface: no `roundRect`. */
    function oldContext() {
      const calls: string[] = [];
      const ctx: Record<string, unknown> = {};
      for (const name of [
        'save',
        'restore',
        'beginPath',
        'fill',
        'arcTo',
        'moveTo',
        'lineTo',
        'closePath',
      ]) {
        ctx[name] = () => calls.push(name);
      }
      return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('still lifts, and paints the shadow without roundRect', () => {
      const { ctx, calls } = oldContext();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
      const fixture = makeStackedView(['a', 'b', 'c']);
      const session = new BlockDragSession(fixture.view);

      expect(() => session.start(lift(0, fixture), X, blockTop(0) + 10)).not.toThrow();

      expect(session.active).toBe(true);
      expect(fixture.dom.querySelectorAll('.futo-mobile-dnd-ghost')).toHaveLength(1);
      expect(calls).toContain('arcTo');
      expect(calls).toContain('fill');
      session.destroy();
    });

    it('a lift that throws leaves nothing behind: no ghost, no dim, not active', () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
        throw new Error('canvas unavailable');
      });
      const fixture = makeStackedView(['a', 'b', 'c']);
      const session = new BlockDragSession(fixture.view);

      expect(() => session.start(lift(0, fixture), X, blockTop(0) + 10)).toThrow(
        'canvas unavailable',
      );

      expect(session.active).toBe(false);
      expect(document.querySelector('.futo-mobile-dnd-ghost')).toBeNull();
      const last = fixture.dispatched[fixture.dispatched.length - 1];
      expect(last.getMeta(blockDragSourceKey).decorationSet.find()).toHaveLength(0);
      // And the session is usable again.
      vi.restoreAllMocks();
      session.start(lift(0, fixture), X, blockTop(0) + 10);
      expect(session.active).toBe(true);
      session.destroy();
    });
  });
});
