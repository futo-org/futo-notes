// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iosTapFocus } from './iosTapFocus';

const views: EditorView[] = [];

function setup(enabled = true): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const resolveTapPosition = vi.fn(({ clientX, clientY }) => clientX === 12 && clientY === 6 ? 3 : null);
  const view = new EditorView({
    doc: 'hello',
    extensions: iosTapFocus({
      enabled,
      resolveTapPosition,
    }),
    parent,
  });
  (view as EditorView & { resolveTapPosition: typeof resolveTapPosition }).resolveTapPosition = resolveTapPosition;
  views.push(view);
  return view;
}

function touchEvent(type: 'touchstart' | 'touchmove' | 'touchend', x = 12, y = 6): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const target = document.createElement('span');
  const touch = { clientX: x, clientY: y, identifier: 1, target };
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [touch] });
  Object.defineProperty(event, 'changedTouches', { value: [touch] });
  Object.defineProperty(event, 'targetTouches', { value: type === 'touchend' ? [] : [touch] });
  return event;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.remove();
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('iosTapFocus', () => {
  it('sets tapped selection and focuses with preventScroll after a tap', () => {
    const view = setup();
    const focus = vi.spyOn(view.contentDOM, 'focus').mockImplementation(() => {});
    const end = touchEvent('touchend');
    const preventDefault = vi.spyOn(end, 'preventDefault');

    view.contentDOM.dispatchEvent(touchEvent('touchstart'));
    view.contentDOM.dispatchEvent(end);

    expect(view.state.selection.main.head).toBe(3);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(preventDefault).toHaveBeenCalled();
    expect((view as EditorView & { resolveTapPosition: ReturnType<typeof vi.fn> }).resolveTapPosition)
      .toHaveBeenCalledWith(expect.objectContaining({ target: expect.any(HTMLSpanElement) }), view);
  });

  it('does not focus or prevent default when the tap position cannot be resolved', () => {
    const view = setup();
    const focus = vi.spyOn(view.contentDOM, 'focus').mockImplementation(() => {});
    const end = touchEvent('touchend', 90, 90);
    const preventDefault = vi.spyOn(end, 'preventDefault');

    view.contentDOM.dispatchEvent(touchEvent('touchstart', 90, 90));
    view.contentDOM.dispatchEvent(end);

    expect(view.state.selection.main.head).toBe(0);
    expect(focus).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does not place a cursor for scroll gestures', () => {
    const view = setup();
    const focus = vi.spyOn(view.contentDOM, 'focus').mockImplementation(() => {});

    view.contentDOM.dispatchEvent(touchEvent('touchstart', 12, 6));
    view.contentDOM.dispatchEvent(touchEvent('touchmove', 12, 40));
    view.contentDOM.dispatchEvent(touchEvent('touchend', 12, 40));

    expect(view.state.selection.main.head).toBe(0);
    expect(focus).not.toHaveBeenCalled();
  });

  it('is a no-op when disabled', () => {
    const view = setup(false);
    const focus = vi.spyOn(view.contentDOM, 'focus').mockImplementation(() => {});

    view.contentDOM.dispatchEvent(touchEvent('touchstart'));
    view.contentDOM.dispatchEvent(touchEvent('touchend'));

    expect(view.state.selection.main.head).toBe(0);
    expect(focus).not.toHaveBeenCalled();
  });
});
