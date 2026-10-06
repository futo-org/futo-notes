// @vitest-environment jsdom
/**
 * The ⠿ handle's press-move-release gesture (handleBlockDrag.ts) against a fake
 * view: that it cuts the plugin's own mouse/HTML5 drag off, that a click does
 * nothing, and what a lift, Escape and a release do. The real engine's side —
 * Playwright's drag interception, the ghost's on-screen box — is
 * tests/editor-embed-milkdown.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from '@milkdown/kit/prose/state';

import { mountHandleBlockDrag } from './handleBlockDrag';
import { blockTop, makeStackedView } from './__fixtures__/stackedBlocksView';

const X = 100;

function pointer(type: string, init: Record<string, unknown> = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    isPrimary: true,
    clientX: X,
    clientY: 0,
    ...init,
  });
  return event;
}

function setup() {
  const fixture = makeStackedView(['a', 'b', 'c']);
  const handleEl = document.createElement('div');
  handleEl.draggable = true;
  document.body.appendChild(handleEl);
  const hideHandle = vi.fn();
  const alpha = fixture.view.state.doc.nodeAt(0)!;
  const mounted = mountHandleBlockDrag({
    handleEl,
    view: () => fixture.view,
    active: () => ({ node: alpha, $pos: { pos: 0 }, el: fixture.element(0) }),
    hideHandle,
  });
  /** What plugin-block attaches to the handle a frame later. */
  const pluginListeners = {
    mousedown: vi.fn(),
    mouseup: vi.fn(),
    dragstart: vi.fn(),
    dragend: vi.fn(),
  };
  for (const [name, listener] of Object.entries(pluginListeners)) {
    handleEl.addEventListener(name, listener);
  }
  const press = () => handleEl.dispatchEvent(pointer('pointerdown', { clientY: blockTop(0) + 10 }));
  const move = (clientY: number) => document.dispatchEvent(pointer('pointermove', { clientY }));
  const release = (clientY: number) => document.dispatchEvent(pointer('pointerup', { clientY }));
  return { fixture, handleEl, hideHandle, mounted, pluginListeners, press, move, release };
}

describe('mountHandleBlockDrag', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.className = '';
  });

  it('cancels the handle’s mousedown and keeps it from the plugin, so no NodeSelection is made', () => {
    const { handleEl, pluginListeners, mounted } = setup();
    const event = new Event('mousedown', { bubbles: true, cancelable: true });

    handleEl.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(pluginListeners.mousedown).not.toHaveBeenCalled();
    mounted.destroy();
  });

  it('cancels dragstart and keeps it from the plugin, so no HTML5 drag or drag image', () => {
    const { handleEl, pluginListeners, mounted } = setup();
    const event = new Event('dragstart', { bubbles: true, cancelable: true });

    handleEl.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(pluginListeners.dragstart).not.toHaveBeenCalled();
    mounted.destroy();
  });

  it('keeps mouseup and dragend from the plugin too', () => {
    const { handleEl, pluginListeners, mounted } = setup();

    handleEl.dispatchEvent(new Event('mouseup', { bubbles: true }));
    handleEl.dispatchEvent(new Event('dragend', { bubbles: true }));

    expect(pluginListeners.mouseup).not.toHaveBeenCalled();
    expect(pluginListeners.dragend).not.toHaveBeenCalled();
    mounted.destroy();
  });

  it('switches draggable off at press', () => {
    const { handleEl, press, mounted } = setup();

    press();

    expect(handleEl.draggable).toBe(false);
    mounted.destroy();
  });

  it('a press and release without movement changes nothing and lifts nothing', () => {
    const { fixture, hideHandle, press, release, mounted } = setup();

    press();
    release(blockTop(0) + 10);

    expect(fixture.dispatched).toHaveLength(0);
    expect(document.querySelector('.futo-mobile-dnd-ghost')).toBeNull();
    expect(hideHandle).not.toHaveBeenCalled();
    mounted.destroy();
  });

  it('movement under the lift distance is still a click', () => {
    const { fixture, press, move, release, mounted } = setup();

    press();
    move(blockTop(0) + 12);
    release(blockTop(0) + 12);

    expect(fixture.dispatched).toHaveLength(0);
    expect(document.querySelector('.futo-mobile-dnd-ghost')).toBeNull();
    mounted.destroy();
  });

  it('lifts past the distance: ghost drawn, handle hidden, nothing else changed yet', () => {
    const { fixture, hideHandle, press, move, mounted } = setup();

    press();
    move(blockTop(0) + 30);

    expect(document.querySelectorAll('.futo-mobile-dnd-ghost')).toHaveLength(1);
    expect(hideHandle).toHaveBeenCalledTimes(1);
    expect(fixture.order()).toEqual(['a', 'b', 'c']);
    mounted.destroy();
  });

  it('ignores a touch or pen pointer', () => {
    const { handleEl, move, mounted } = setup();

    handleEl.dispatchEvent(pointer('pointerdown', { pointerType: 'touch', clientY: blockTop(0) }));
    move(blockTop(0) + 40);

    expect(document.querySelector('.futo-mobile-dnd-ghost')).toBeNull();
    mounted.destroy();
  });

  it('commits the move on release and carries the user’s caret with the block', () => {
    const { fixture, press, move, release, mounted } = setup();
    fixture.view.dispatch(
      fixture.view.state.tr.setSelection(TextSelection.create(fixture.view.state.doc, 1)),
    );
    fixture.dispatched.length = 0;

    press();
    move(blockTop(0) + 30);
    move(fixture.lowerHalf(2));
    release(fixture.lowerHalf(2));

    expect(fixture.order()).toEqual(['b', 'c', 'a']);
    expect(fixture.dispatched.filter((tr) => tr.docChanged)).toHaveLength(1);
    const { $head } = fixture.view.state.selection;
    expect($head.parent.textContent).toBe('a');
    expect(document.querySelector('.futo-mobile-dnd-ghost')).toBeNull();
    mounted.destroy();
  });

  it('Escape mid-drag cancels with no document change, and the release after it does nothing', () => {
    const { fixture, press, move, release, mounted } = setup();

    press();
    move(fixture.lowerHalf(2));
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    release(fixture.lowerHalf(2));

    expect(escape.defaultPrevented).toBe(true);
    expect(document.querySelector('.futo-mobile-dnd-ghost')).toBeNull();
    expect(fixture.order()).toEqual(['a', 'b', 'c']);
    expect(fixture.dispatched.every((tr) => !tr.docChanged)).toBe(true);
    mounted.destroy();
  });

  it('Escape on a bare press is left alone for whatever else wants it', () => {
    const { press, mounted } = setup();

    press();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(false);
    mounted.destroy();
  });

  it('refuses a press the plugin’s hover result no longer describes', () => {
    const fixture = makeStackedView(['a', 'b']);
    const handleEl = document.createElement('div');
    document.body.appendChild(handleEl);
    const stale = fixture.view.state.doc.nodeAt(0)!;
    const mounted = mountHandleBlockDrag({
      handleEl,
      view: () => fixture.view,
      // The node the hover found sits at 3 now, not 0.
      active: () => ({ node: stale, $pos: { pos: 3 }, el: fixture.element(0) }),
      hideHandle: () => {},
    });

    handleEl.dispatchEvent(pointer('pointerdown', { clientY: blockTop(0) }));
    document.dispatchEvent(pointer('pointermove', { clientY: blockTop(0) + 40 }));

    expect(document.querySelector('.futo-mobile-dnd-ghost')).toBeNull();
    mounted.destroy();
  });
});
