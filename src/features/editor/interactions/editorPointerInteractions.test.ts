// @vitest-environment jsdom
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findUrlAtPosition } from '../links/autolinks';
import {
  isMarkdownSelectionRevealSuppressed,
  markdownSelectionRevealState,
} from '../live-preview/selectionReveal';
import {
  editorPointerInteractions,
  type EditorLinkActivation,
  type EditorPointerProfile,
} from './editorPointerInteractions';
import { lineHitAtPoint, positionBelowText, resolveTapPositionAt } from './pointerHitTest';

vi.mock('../links/autolinks', () => ({ findUrlAtPosition: vi.fn(() => 'https://example.com') }));
vi.mock('./pointerHitTest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pointerHitTest')>()),
  getRenderedRowRight: vi.fn(),
  lineHitAtPoint: vi.fn(),
  lineHitBesidePoint: vi.fn(),
  positionBelowText: vi.fn(() => EditorSelection.cursor(3)),
  resolveTapPositionAt: vi.fn(() => EditorSelection.cursor(3, -1)),
  rowEndSelectionAt: vi.fn(),
}));

const views: EditorView[] = [];

function setup(profile: EditorPointerProfile = 'native-android', doc = 'hello') {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const activations: EditorLinkActivation[] = [];
  const onWindowBlur = vi.fn();
  const view = new EditorView({
    doc,
    extensions: editorPointerInteractions({
      profile,
      activateLink: (activation) => activations.push(activation),
      onWindowBlur,
    }),
    parent,
  });
  views.push(view);
  return { activations, onWindowBlur, view };
}

function dispatchMouse(
  view: EditorView,
  type: 'mousedown' | 'click' | 'auxclick',
  init: MouseEventInit = {},
  target: Element = view.contentDOM,
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function touchEvent(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  target: Element,
  clientX = 12,
  clientY = 6,
  touchCount = 1,
  timeStamp?: number,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touch = { clientX, clientY, identifier: 1, target };
  const touches =
    type === 'touchend' || type === 'touchcancel'
      ? []
      : Array.from({ length: touchCount }, () => touch);
  Object.defineProperties(event, {
    touches: { value: touches },
    changedTouches: { value: [touch] },
    targetTouches: { value: touches },
    ...(timeStamp === undefined ? {} : { timeStamp: { value: timeStamp } }),
  });
  return event;
}

function dispatchTouchTap(view: EditorView, clientY: number, timeStamp?: number): Event {
  return dispatchTouchTapAt(view.contentDOM, clientY, timeStamp);
}

function dispatchTouchTapAt(target: Element, clientY: number, timeStamp?: number): Event {
  target.dispatchEvent(touchEvent('touchstart', target, 12, clientY, 1, timeStamp));
  const end = touchEvent('touchend', target, 12, clientY, 1, timeStamp);
  target.dispatchEvent(end);
  return end;
}

function dispatchNativeCompatibilityPress(
  view: EditorView,
  detail: number,
  clientY: number,
): Event {
  const touchEnd = dispatchTouchTap(view, clientY);
  if (touchEnd.defaultPrevented) return touchEnd;
  const down = dispatchMouse(view, 'mousedown', { detail, clientY });
  dispatchMouse(view, 'click', { detail, clientY });
  return down;
}

function addWikilink(view: EditorView, broken = false): HTMLElement {
  const wikilink = document.createElement('span');
  wikilink.className = `cm-md-link cm-md-wikilink${broken ? ' cm-md-wikilink-broken' : ''}`;
  wikilink.dataset.wikilink = 'Target';
  view.contentDOM.querySelector('.cm-line')?.appendChild(wikilink);
  document.elementFromPoint = () => wikilink;
  return wikilink;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

beforeEach(() => {
  document.elementFromPoint = () => null;
});

describe('editorPointerInteractions native caret policy', () => {
  describe.each(['native-ios', 'native-android'] as const)('%s modifier policy', (profile) => {
    for (const modifier of ['shiftKey', 'altKey', 'metaKey', 'ctrlKey'] as const) {
      it(`leaves ${modifier} primary presses to the native platform`, () => {
        const { view } = setup(profile);
        const focus = vi.spyOn(view, 'focus');

        dispatchMouse(view, 'mousedown', { [modifier]: true });

        expect(positionBelowText).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
      });
    }
  });

  it('places a native off-text caret on mousedown and consumes its click', () => {
    const { view } = setup();

    dispatchMouse(view, 'mousedown');
    const click = dispatchMouse(view, 'click');

    expect(view.state.selection.main.head).toBe(3);
    expect(click.defaultPrevented).toBe(true);
    expect(resolveTapPositionAt).not.toHaveBeenCalled();
  });

  it('corrects an ordinary Android line click after the native tap', () => {
    const { view } = setup();

    dispatchMouse(view, 'click');

    expect(resolveTapPositionAt).toHaveBeenCalledOnce();
    expect(view.state.selection.main.head).toBe(3);
  });

  it('does not correct iOS click placement or Android double-click release', () => {
    const ios = setup('native-ios').view;
    const android = setup('native-android').view;

    dispatchMouse(ios, 'click');
    dispatchMouse(android, 'click', { detail: 2 });

    expect(resolveTapPositionAt).not.toHaveBeenCalled();
  });

  describe.each(['native-ios', 'native-android'] as const)(
    '%s off-text word selection',
    (profile) => {
      it('selects the word under the resolved column just below the text', () => {
        const { view } = setup(profile, 'alpha bravo');
        view.focus();

        vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(2));
        dispatchNativeCompatibilityPress(view, 1, 20);
        const near = dispatchNativeCompatibilityPress(view, 2, 20);

        expect(view.state.selection.main).toEqual(EditorSelection.range(0, 5));
        expect(near.defaultPrevented).toBe(true);
      });

      it('selects the final word when the far-below position resolves to the note end', () => {
        const { view } = setup(profile, 'alpha bravo.');
        view.focus();

        vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(12));
        dispatchNativeCompatibilityPress(view, 1, 200);
        const far = dispatchNativeCompatibilityPress(view, 2, 200);

        expect(view.state.selection.main).toEqual(EditorSelection.range(6, 11));
        expect(far.defaultPrevented).toBe(true);
      });

      it('does not combine off-text presses across a document edit', () => {
        const { view } = setup(profile, 'alpha bravo');
        view.focus();
        vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(11));

        dispatchNativeCompatibilityPress(view, 1, 200);
        view.dispatch({ changes: { from: 11, insert: 'X' } });
        vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(12));
        const nextPress = dispatchNativeCompatibilityPress(view, 2, 200);

        expect(view.state.selection.main).toEqual(EditorSelection.cursor(12));
        expect(nextPress.defaultPrevented).toBe(true);
      });

      it.each(['scroll', 'cancel'] as const)(
        'does not combine off-text presses across a touch %s',
        (interruption) => {
          const { view } = setup(profile, 'alpha bravo');
          view.focus();
          vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(11));
          dispatchNativeCompatibilityPress(view, 1, 200);

          view.contentDOM.dispatchEvent(touchEvent('touchstart', view.contentDOM, 12, 200));
          if (interruption === 'scroll') {
            view.contentDOM.dispatchEvent(touchEvent('touchmove', view.contentDOM, 12, 240));
            view.contentDOM.dispatchEvent(touchEvent('touchend', view.contentDOM, 12, 240));
          } else {
            view.contentDOM.dispatchEvent(touchEvent('touchcancel', view.contentDOM, 12, 200));
          }
          const nextPress = dispatchNativeCompatibilityPress(view, 2, 200);

          expect(view.state.selection.main).toEqual(EditorSelection.cursor(11));
          expect(nextPress.defaultPrevented).toBe(true);
        },
      );
    },
  );

  describe.each(['native-ios', 'native-android'] as const)(
    '%s on-text selection ownership',
    (profile) => {
      it('leaves on-text double clicks to the platform', () => {
        const { view } = setup(profile);
        vi.mocked(positionBelowText).mockReturnValueOnce(null);

        dispatchMouse(view, 'mousedown', { detail: 2 });
        const selection = view.state.selection.main;

        expect(view.state.doc.sliceString(selection.from, selection.to)).toBe('hello');
      });

      it('leaves triple-click line selection to the platform', () => {
        const { view } = setup(profile);

        dispatchMouse(view, 'mousedown', { detail: 3 });

        expect(lineHitAtPoint).not.toHaveBeenCalled();
      });
    },
  );

  describe.each(['browser-ios', 'native-ios'] as const)('%s first-tap focus', (profile) => {
    it('focuses without scrolling and preserves row association', () => {
      const { view } = setup(profile);
      const focus = vi.spyOn(view.contentDOM, 'focus').mockImplementation(() => {});
      const end = touchEvent('touchend', view.contentDOM);
      vi.mocked(positionBelowText).mockReturnValueOnce(null);

      view.contentDOM.dispatchEvent(touchEvent('touchstart', view.contentDOM));
      view.contentDOM.dispatchEvent(end);

      expect(end.defaultPrevented).toBe(true);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(view.state.selection.main).toEqual(EditorSelection.cursor(3, -1));
    });
  });

  it('leaves focused on-text iOS taps and touch scroll gestures to WebKit', () => {
    const focused = setup('native-ios').view;
    focused.focus();
    vi.mocked(positionBelowText).mockReturnValueOnce(null);
    focused.contentDOM.dispatchEvent(touchEvent('touchstart', focused.contentDOM));
    focused.contentDOM.dispatchEvent(touchEvent('touchend', focused.contentDOM));

    const scrolled = setup('native-ios').view;
    scrolled.contentDOM.dispatchEvent(touchEvent('touchstart', scrolled.contentDOM, 12, 6));
    scrolled.contentDOM.dispatchEvent(touchEvent('touchmove', scrolled.contentDOM, 12, 40));
    scrolled.contentDOM.dispatchEvent(touchEvent('touchend', scrolled.contentDOM, 12, 40));

    expect(resolveTapPositionAt).not.toHaveBeenCalled();
  });

  it('cancels a touch gesture after multitouch or touchcancel', () => {
    const { activations, view } = setup('native-android');
    const wikilink = addWikilink(view);

    wikilink.dispatchEvent(touchEvent('touchstart', wikilink));
    wikilink.dispatchEvent(touchEvent('touchmove', wikilink, 12, 6, 2));
    wikilink.dispatchEvent(touchEvent('touchend', wikilink));
    wikilink.dispatchEvent(touchEvent('touchstart', wikilink));
    wikilink.dispatchEvent(touchEvent('touchcancel', wikilink));
    wikilink.dispatchEvent(touchEvent('touchend', wikilink));

    expect(activations).toEqual([]);
  });
});

describe('editorPointerInteractions iOS off-text touch placement', () => {
  it.each(['browser-ios', 'native-ios'] as const)(
    '%s owns taps from the non-editable scroller tail',
    (profile) => {
      const { view } = setup(profile, 'alpha bravo');
      view.focus();
      vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(2));

      const end = dispatchTouchTapAt(view.scrollDOM, 20, 100);

      expect(view.dom.dataset.iosOffTextSurface).toBe('true');
      expect(end.defaultPrevented).toBe(true);
      expect(view.state.selection.main).toEqual(EditorSelection.cursor(2));
    },
  );

  it('leaves editor-root overlays outside the scroller to their own touch handlers', () => {
    const { view } = setup('native-ios', 'alpha bravo');
    const overlayItem = document.createElement('button');
    overlayItem.className = 'sf-slash-menu-item';
    view.dom.appendChild(overlayItem);

    const end = dispatchTouchTapAt(overlayItem, 200, 100);

    expect(end.defaultPrevented).toBe(false);
    expect(positionBelowText).not.toHaveBeenCalled();
  });

  it('places a focused single tap on touchend before WebKit can jump to the note end', () => {
    const { view } = setup('native-ios', 'alpha bravo');
    view.focus();
    vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(2));

    const end = dispatchTouchTap(view, 20, 100);

    expect(end.defaultPrevented).toBe(true);
    expect(view.state.selection.main).toEqual(EditorSelection.cursor(2));
  });

  it.each([
    ['column word just below the text', 2, 20, EditorSelection.range(0, 5)],
    ['final word far below the text', 12, 200, EditorSelection.range(6, 11)],
  ] as const)('selects the %s from the real double-touch sequence', (_, position, y, expected) => {
    const { view } = setup('native-ios', 'alpha bravo.');
    view.focus();
    vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(position));

    dispatchTouchTap(view, y, 100);
    const secondEnd = dispatchTouchTap(view, y, 250);

    expect(secondEnd.defaultPrevented).toBe(true);
    expect(view.state.selection.main).toEqual(expected);
  });

  it.each([
    ['just below the text', 18, 20],
    ['far below the text', 28, 200],
  ] as const)('selects the final paragraph on a third tap %s', (_, position, y) => {
    const { view } = setup('native-ios', 'first paragraph\nalpha bravo.');
    view.focus();
    vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(position));

    dispatchTouchTap(view, y, 100);
    dispatchTouchTap(view, y, 250);
    const thirdEnd = dispatchTouchTap(view, y, 400);

    expect(thirdEnd.defaultPrevented).toBe(true);
    expect(view.state.selection.main).toEqual(EditorSelection.range(16, 28));
  });

  it.each(['alpha bravo.\n', 'alpha bravo.\n\n'])(
    'selects the final visible paragraph on a third tap when the note ends in blank lines',
    (document) => {
      const { view } = setup('native-ios', document);
      view.focus();
      vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(document.length));

      dispatchTouchTap(view, 200, 100);
      dispatchTouchTap(view, 200, 250);
      const thirdEnd = dispatchTouchTap(view, 200, 400);

      expect(thirdEnd.defaultPrevented).toBe(true);
      expect(view.state.selection.main).toEqual(EditorSelection.range(0, 12));
    },
  );

  it('does not combine off-text taps across an interactive table-link gesture', () => {
    const { view } = setup('native-ios', 'alpha bravo');
    view.focus();
    vi.mocked(positionBelowText).mockReturnValue(EditorSelection.cursor(2));
    dispatchTouchTapAt(view.scrollDOM, 20, 100);

    const link = document.createElement('a');
    link.className = 'cm-md-table-link';
    view.contentDOM.appendChild(link);
    dispatchTouchTapAt(link, 20, 180);
    dispatchTouchTapAt(view.scrollDOM, 20, 250);

    expect(view.state.selection.main).toEqual(EditorSelection.cursor(2));
  });
});

describe('editorPointerInteractions link arbitration', () => {
  it('activates a resolved link before iOS first-focus placement', () => {
    const { activations, view } = setup('native-ios');
    const wikilink = addWikilink(view);
    const end = touchEvent('touchend', wikilink);

    wikilink.dispatchEvent(touchEvent('touchstart', wikilink));
    wikilink.dispatchEvent(end);

    expect(activations).toEqual([
      {
        target: { kind: 'wikilink', title: 'Target' },
        gesture: { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false },
      },
    ]);
    expect(resolveTapPositionAt).not.toHaveBeenCalled();
    expect(end.defaultPrevented).toBe(true);
  });

  it('keeps the touch link target when first focus reveals its markdown', () => {
    const { activations, view } = setup('native-ios');
    const wikilink = addWikilink(view);

    wikilink.dispatchEvent(touchEvent('touchstart', wikilink));
    wikilink.removeAttribute('data-wikilink');
    wikilink.className = '';
    wikilink.dispatchEvent(touchEvent('touchend', wikilink));

    expect(activations[0]?.target).toEqual({ kind: 'wikilink', title: 'Target' });
    expect(resolveTapPositionAt).not.toHaveBeenCalled();
  });

  it('uses an unfocused broken iOS wikilink as an editing focus tap', () => {
    const { activations, view } = setup('native-ios');
    const wikilink = addWikilink(view, true);
    vi.mocked(positionBelowText).mockReturnValueOnce(null);

    wikilink.dispatchEvent(touchEvent('touchstart', wikilink));
    wikilink.dispatchEvent(touchEvent('touchend', wikilink));

    expect(activations).toEqual([]);
    expect(resolveTapPositionAt).toHaveBeenCalledOnce();
  });

  it('snapshots a mouse wikilink through click and preserves navigation modifiers', () => {
    const { activations, view } = setup('native-android');
    const wikilink = addWikilink(view);

    dispatchMouse(view, 'mousedown', { metaKey: true }, wikilink);
    wikilink.remove();
    dispatchMouse(view, 'click', { metaKey: true });

    expect(activations[0]).toEqual({
      target: { kind: 'wikilink', title: 'Target' },
      gesture: { button: 0, altKey: false, ctrlKey: false, metaKey: true, shiftKey: false },
    });
  });

  it('does not activate a mouse link after the pointer moves away', () => {
    const { activations, view } = setup('native-android');
    const wikilink = addWikilink(view);

    dispatchMouse(view, 'mousedown', { clientX: 4, clientY: 5 }, wikilink);
    dispatchMouse(view, 'click', { clientX: 20, clientY: 5 });

    expect(activations).toEqual([]);
  });

  it('resolves external links through the same semantic activation seam', () => {
    const { activations, view } = setup('native-android');
    const external = document.createElement('span');
    external.className = 'cm-md-link';
    external.getClientRects = () =>
      [{ left: 0, right: 20, top: 0, bottom: 20 }] as unknown as DOMRectList;
    view.contentDOM.querySelector('.cm-line')?.appendChild(external);
    document.elementFromPoint = () => external;
    vi.spyOn(view, 'posAtDOM').mockReturnValue(2);

    dispatchMouse(view, 'mousedown', {}, external);
    dispatchMouse(view, 'click');

    expect(findUrlAtPosition).toHaveBeenCalled();
    expect(activations[0]?.target).toEqual({ kind: 'external', url: 'https://example.com' });
  });
});

describe('editorPointerInteractions desktop lifecycle', () => {
  it('keeps desktop reveal state local to its editor during a drag', () => {
    const first = setup('desktop').view;
    const second = setup('desktop').view;

    dispatchMouse(first, 'mousedown', { clientX: 4, clientY: 5 });
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 8, clientY: 5 }));

    expect(isMarkdownSelectionRevealSuppressed(first.state)).toBe(true);
    expect(isMarkdownSelectionRevealSuppressed(second.state)).toBe(false);
    expect(first.dom.hasAttribute('data-selection-reveal-suppressed')).toBe(true);

    window.dispatchEvent(new MouseEvent('mouseup'));

    expect(isMarkdownSelectionRevealSuppressed(first.state)).toBe(false);
    expect(first.dom.hasAttribute('data-selection-reveal-suppressed')).toBe(false);
  });

  it('maps a frozen reveal snapshot through document edits', () => {
    const { view } = setup('desktop');
    view.dispatch({ selection: { anchor: 2 } });
    dispatchMouse(view, 'mousedown');
    view.dispatch({ changes: { from: 0, insert: 'x' } });

    const reveal = view.state.field(markdownSelectionRevealState);
    expect(reveal.frozen?.ranges[0].from).toBe(3);
  });

  it('cancels delayed line selection when the editor is destroyed', () => {
    vi.useFakeTimers();
    const { view } = setup('desktop');
    vi.mocked(lineHitAtPoint).mockReturnValue({
      line: view.state.doc.line(1),
      lineElement: view.contentDOM.querySelector('.cm-line') as HTMLElement,
    });
    const dispatch = vi.spyOn(view, 'dispatch');

    dispatchMouse(view, 'mousedown', { detail: 3 });
    view.destroy();
    vi.runAllTimers();

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ selection: expect.anything() }),
    );
  });

  it('reports desktop window blur and removes its listeners on destroy', () => {
    const { onWindowBlur, view } = setup('desktop');

    window.dispatchEvent(new Event('blur'));
    expect(onWindowBlur).toHaveBeenCalledOnce();

    view.destroy();
    onWindowBlur.mockClear();
    window.dispatchEvent(new Event('blur'));
    expect(onWindowBlur).not.toHaveBeenCalled();
  });
});
