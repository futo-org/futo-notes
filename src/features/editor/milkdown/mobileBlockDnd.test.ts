// @vitest-environment jsdom
/**
 * Unit coverage for the focus-arbitration gate in `mobileBlockDnd.ts` (QA
 * #001, product decision 2026-09-11 — see the module doc's "FOCUS ARBITRATES
 * DRAG VS. SELECTION").
 *
 * The bug this closes: the plugin used to arm the long-press/selection
 * suppression for every touch regardless of focus, which made a phone's
 * editor unselectable — long-pressing a word to select it was always read as
 * "lift this block" instead. The fix gates arming, at `pointerdown`, on
 * `view.hasFocus()`: a press that starts with the editor already focused
 * (soft keyboard up) is left completely alone (text selection/caret
 * placement, untouched); a press that starts unfocused (keyboard down) arms
 * and may lift a block exactly as before. This exercises `MobileBlockDndView`
 * directly against a fake `ProseView` (see its export comment) — the real
 * gesture, a physical long-press against a real WebView, is
 * `tests/editor-embed-milkdown.spec.ts`'s job, and cf343347's own focus-
 * capture guard (Chromium forcing focus onto an unfocused-start press mid-
 * gesture) already has device-measured coverage there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import {
  DEFAULT_LONG_PRESS_MS,
  MobileBlockDndView,
  dropBlockDndFocusGuards,
  needsSelectionNet,
  type MobileBlockDndOptions,
} from './mobileBlockDnd';
import { testSchema } from './__fixtures__/schema';

const s = testSchema;

/** Real user-agent strings, by engine. */
const UA = {
  iosWebView:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  iosEdge:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/125.2535.60 Mobile/15E148 Safari/605.1.15',
  iosFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
  ipadSafariDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidWebView90:
    'Mozilla/5.0 (Linux; Android 11; Pixel 4 Build/RQ3A.210805.001.A1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/90.0.4430.210 Mobile Safari/537.36',
  androidWebView120:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240105.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36',
  chromeDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  safariDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  webKitGtk:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  firefoxDesktop: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
};

const BLOCK_TOP = 100;
const BLOCK_HEIGHT = 40;
const BLOCK_LEFT = 24;
const BLOCK_WIDTH = 300;
const BLOCK_X = BLOCK_LEFT + BLOCK_WIDTH / 2;

function paragraph(text: string): ProseNode {
  return s.nodes.paragraph.create(null, s.text(text));
}

function rectAt(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: BLOCK_LEFT,
    right: BLOCK_LEFT + BLOCK_WIDTH,
    width: BLOCK_WIDTH,
    height: bottom - top,
    x: BLOCK_LEFT,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * One top-level paragraph, "a", as a fixed box. `view.dom` is a REAL element
 * (not a stub object): the plugin binds `addEventListener` directly to it and
 * to its `ownerDocument`, so it has to be something the DOM can actually
 * dispatch through.
 */
function makeView(hasFocus: boolean, empty = false) {
  const doc = s.nodes.doc.create(null, [empty ? s.nodes.paragraph.create() : paragraph('a')]);
  let state = EditorState.create({ doc });
  const dispatched: Transaction[] = [];

  const dom = document.createElement('div');
  dom.className = 'futo-milkdown ProseMirror';
  dom.getBoundingClientRect = () => rectAt(BLOCK_TOP - 20, BLOCK_TOP + BLOCK_HEIGHT + 20);
  document.body.appendChild(dom);

  const aEl = document.createElement('p');
  aEl.getBoundingClientRect = () => rectAt(BLOCK_TOP, BLOCK_TOP + BLOCK_HEIGHT);

  let focused = hasFocus;
  const focusFn = vi.fn();

  const view = {
    get state() {
      return state;
    },
    dom,
    dispatch: (tr: Transaction) => {
      dispatched.push(tr);
      state = state.apply(tr);
    },
    hasFocus: () => focused,
    focus: focusFn,
    nodeDOM: (at: number) => (at === 0 ? aEl : null),
    posAtCoords: ({ top: y }: { left: number; top: number }) => {
      if (y >= BLOCK_TOP && y <= BLOCK_TOP + BLOCK_HEIGHT) return { pos: 1, inside: -1 };
      return { pos: doc.content.size, inside: -1 };
    },
  } as unknown as ProseView & { focus: typeof focusFn };

  return {
    view,
    dom,
    dispatched,
    setFocused: (value: boolean) => {
      focused = value;
    },
    /** Centre of the block, where a real touch would land. */
    pointA: { x: BLOCK_X, y: BLOCK_TOP + BLOCK_HEIGHT / 2 },
  };
}

function pointerEvent(
  type: string,
  overrides: Partial<{
    clientX: number;
    clientY: number;
    pointerId: number;
    pointerType: string;
  }> = {},
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.assign(event, {
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    pointerType: 'touch',
    ...overrides,
  });
  return event;
}

function makeOptions(): {
  options: MobileBlockDndOptions;
  onHaptic: ReturnType<typeof vi.fn>;
  onDragActive: ReturnType<typeof vi.fn>;
  onPressActive: ReturnType<typeof vi.fn>;
} {
  const onHaptic = vi.fn();
  const onDragActive = vi.fn();
  const onPressActive = vi.fn();
  return {
    options: { onHaptic, onDragActive, onPressActive },
    onHaptic,
    onDragActive,
    onPressActive,
  };
}

describe('MobileBlockDndView — focus arbitration (QA #001)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a press that begins FOCUSED arms nothing at all — selection is left to the platform', () => {
    const { view, dom, pointA } = makeView(/* hasFocus */ true);
    const { options, onPressActive } = makeOptions();
    const pluginView = new MobileBlockDndView(view, options);

    dom.dispatchEvent(pointerEvent('pointerdown', { clientX: pointA.x, clientY: pointA.y }));

    // Not one lever engaged: no arm class, no press callback, and — because
    // no gesture listeners were installed — a native selectstart runs exactly
    // as it would with this plugin absent.
    expect(dom.classList.contains('futo-mobile-dnd-armed')).toBe(false);
    expect(onPressActive).not.toHaveBeenCalled();
    const selectStart = new Event('selectstart', { bubbles: true, cancelable: true });
    document.dispatchEvent(selectStart);
    expect(selectStart.defaultPrevented).toBe(false);

    // Holding well past the lift timer changes nothing: there is no timer,
    // because the gate returned before one was ever set.
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS + 500);
    expect(dom.classList.contains('futo-mobile-dnd-armed')).toBe(false);

    pluginView.destroy();
    dom.remove();
  });

  it('a press that begins UNFOCUSED arms and lifts exactly as before', () => {
    const { view, dom, pointA } = makeView(/* hasFocus */ false);
    const { options, onDragActive, onHaptic } = makeOptions();
    const pluginView = new MobileBlockDndView(view, options);

    dom.dispatchEvent(pointerEvent('pointerdown', { clientX: pointA.x, clientY: pointA.y }));
    expect(dom.classList.contains('futo-mobile-dnd-armed')).toBe(true);

    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS);

    expect(onDragActive).toHaveBeenCalledWith(true);
    expect(onHaptic).toHaveBeenCalledWith('lift');

    pluginView.destroy();
    dom.remove();
  });

  it('hides the selection only where iOS WebKit needs it, and removes it with the arm class', () => {
    for (const [nav, expected] of [
      [{ userAgent: UA.iosWebView }, true],
      // Android WebView 90: Chromium without `userAgentData` (added in 116).
      [{ userAgent: UA.androidWebView90 }, false],
    ] as const) {
      vi.stubGlobal('navigator', nav);
      const { view, dom, pointA } = makeView(/* hasFocus */ false);
      const { options } = makeOptions();
      const pluginView = new MobileBlockDndView(view, options);

      dom.dispatchEvent(pointerEvent('pointerdown', { clientX: pointA.x, clientY: pointA.y }));
      expect(dom.classList.contains('futo-mobile-dnd-armed')).toBe(true);
      expect(dom.classList.contains('futo-mobile-dnd-hide-selection')).toBe(expected);

      dom.dispatchEvent(pointerEvent('pointerup', { clientX: pointA.x, clientY: pointA.y }));
      expect(dom.classList.contains('futo-mobile-dnd-hide-selection')).toBe(false);

      pluginView.destroy();
      dom.remove();
      vi.unstubAllGlobals();
    }
  });

  it('re-reads focus fresh on every gesture instead of caching the first answer', () => {
    const { view, dom, setFocused, pointA } = makeView(/* hasFocus */ true);
    const { options, onPressActive } = makeOptions();
    const pluginView = new MobileBlockDndView(view, options);

    // First gesture: focused, gate closed.
    dom.dispatchEvent(
      pointerEvent('pointerdown', { clientX: pointA.x, clientY: pointA.y, pointerId: 1 }),
    );
    expect(onPressActive).not.toHaveBeenCalled();

    // Second gesture, now unfocused — must not remember the first answer.
    setFocused(false);
    dom.dispatchEvent(
      pointerEvent('pointerdown', { clientX: pointA.x, clientY: pointA.y, pointerId: 2 }),
    );
    expect(onPressActive).toHaveBeenCalledWith(true);

    document.dispatchEvent(pointerEvent('pointerup', { pointerId: 2 }));
    pluginView.destroy();
    dom.remove();
  });

  // cf343347's own guard is what this gate must NOT undo: an unfocused-start
  // press that Chromium's own long-press forces focus onto mid-gesture is
  // still de-focused, WITHOUT the in-progress drag being cancelled — this is
  // the reconciliation point between the two fixes (see the module doc's
  // "FOCUS ARBITRATES DRAG VS. SELECTION"). Playwright's desktop Chromium
  // does not reproduce Chromium's forced focus itself (module doc), so this
  // simulates it mid-press with a direct `view.dom` focus, same as
  // tests/editor-embed-milkdown.spec.ts does against the real bundle.
  it('an unfocused-start press that is force-focused mid-press is de-focused, and the drag keeps going', () => {
    const { view, dom, pointA } = makeView(/* hasFocus */ false);
    const { options, onDragActive, onHaptic } = makeOptions();
    const pluginView = new MobileBlockDndView(view, options);

    dom.dispatchEvent(pointerEvent('pointerdown', { clientX: pointA.x, clientY: pointA.y }));
    vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS); // lift
    expect(onDragActive).toHaveBeenCalledWith(true);
    onDragActive.mockClear();

    // Stands in for Chromium's own long-press forcing focus onto the
    // editable (module doc: measured on the pool emulator, not reproducible
    // in Playwright's Chromium either).
    dom.focus();
    const focusEvent = new FocusEvent('focus', { bubbles: false });
    Object.defineProperty(focusEvent, 'target', { value: dom });
    document.dispatchEvent(focusEvent);

    // De-focused — the guard fired — and the drag was NOT cancelled: no
    // second `onDragActive(false)` was reported for this focus event.
    expect(onDragActive).not.toHaveBeenCalledWith(false);

    document.dispatchEvent(pointerEvent('pointerup', {}));
    pluginView.destroy();
    dom.remove();
  });

  // RC-84: the native click that focuses the editable after a released hold is
  // a separate task, and under load whole frames run before it. The guard that
  // absorbs it used to last one requestAnimationFrame, so a slow click left the
  // editor focused and the NEXT press (which never arms over a focused editor)
  // silently did nothing.
  describe('the release-time focus guard outlives frames, not presses', () => {
    // The empty paragraph is the release that ends in a native click and never
    // lifts; a lifted drag is covered separately below.
    function holdAndRelease() {
      const rig = makeView(/* hasFocus */ false, /* empty */ true);
      rig.dom.tabIndex = -1; // focusable in jsdom
      const pluginView = new MobileBlockDndView(rig.view, makeOptions().options);
      rig.dom.dispatchEvent(
        pointerEvent('pointerdown', { clientX: rig.pointA.x, clientY: rig.pointA.y }),
      );
      vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS + 150);
      document.dispatchEvent(pointerEvent('pointerup', {}));
      return { ...rig, pluginView };
    }

    it('still blurs a native-click focus that arrives after several animation frames', () => {
      const { dom, pluginView } = holdAndRelease();
      vi.advanceTimersByTime(200); // many frames under load
      dom.focus();
      expect(document.activeElement).not.toBe(dom);
      pluginView.destroy();
      dom.remove();
    });

    it('is gone once the next press starts, so a tap still places the caret', () => {
      const { dom, pointA, pluginView } = holdAndRelease();
      dom.dispatchEvent(pointerEvent('pointerdown', { clientX: pointA.x, clientY: pointA.y }));
      document.dispatchEvent(pointerEvent('pointerup', {}));
      dom.focus();
      expect(document.activeElement).toBe(dom);
      pluginView.destroy();
      dom.remove();
    });

    it('expires, so it never swallows a later programmatic focus', () => {
      const { dom, pluginView } = holdAndRelease();
      vi.advanceTimersByTime(1500);
      dom.focus();
      expect(document.activeElement).toBe(dom);
      pluginView.destroy();
      dom.remove();
    });

    // R10-FB20-1: the host's own focus() is intentional and must get through.
    it('lets a host focus() through once the editor drops the guard', () => {
      const { dom, pluginView } = holdAndRelease();
      vi.advanceTimersByTime(100);
      dropBlockDndFocusGuards();
      dom.focus();
      expect(document.activeElement).toBe(dom);
      pluginView.destroy();
      dom.remove();
    });

    it('a lifted drag release keeps only the one-frame guard (a moved touch emits no click)', () => {
      const rig = makeView(/* hasFocus */ false);
      rig.dom.tabIndex = -1;
      const pluginView = new MobileBlockDndView(rig.view, makeOptions().options);
      rig.dom.dispatchEvent(
        pointerEvent('pointerdown', { clientX: rig.pointA.x, clientY: rig.pointA.y }),
      );
      vi.advanceTimersByTime(DEFAULT_LONG_PRESS_MS + 10); // lifted
      document.dispatchEvent(pointerEvent('pointerup', {}));
      vi.advanceTimersByTime(100); // frames later, well inside the 1 s window
      rig.dom.focus();
      expect(document.activeElement).toBe(rig.dom);
      pluginView.destroy();
      rig.dom.remove();
    });
  });

  it('a plain tap while unfocused (armed but released before the lift timer) never calls view.focus', () => {
    const { view, dom, pointA } = makeView(/* hasFocus */ false);
    const { options } = makeOptions();
    const pluginView = new MobileBlockDndView(view, options);

    dom.dispatchEvent(pointerEvent('pointerdown', { clientX: pointA.x, clientY: pointA.y }));
    document.dispatchEvent(pointerEvent('pointerup', {}));

    expect(dom.classList.contains('futo-mobile-dnd-armed')).toBe(false);
    // The arm/disarm dance never itself grabs focus — a tap's normal
    // focus-and-caret-placement is the platform's own doing, untouched by
    // this plugin (module doc's `finish()` note).
    expect((view as unknown as { focus: ReturnType<typeof vi.fn> }).focus).not.toHaveBeenCalled();

    pluginView.destroy();
    dom.remove();
  });
});

describe('needsSelectionNet', () => {
  it.each([
    ['iOS WKWebView', { userAgent: UA.iosWebView }, true],
    ['iOS Chrome (CriOS is WebKit)', { userAgent: UA.iosChrome }, true],
    ['iOS Edge', { userAgent: UA.iosEdge }, true],
    ['iOS Firefox', { userAgent: UA.iosFirefox }, true],
    ['desktop Safari', { userAgent: UA.safariDesktop }, true],
    ['iPad in desktop mode (Safari UA)', { userAgent: UA.ipadSafariDesktopMode }, true],
    ['WebKitGTK', { userAgent: UA.webKitGtk }, true],
    ['Firefox desktop', { userAgent: UA.firefoxDesktop }, true],
    ['Firefox Android', { userAgent: UA.firefoxAndroid }, true],
    ['an unknown engine', { userAgent: 'SomeBrowser/1.0' }, true],
    ['no navigator', undefined, true],
    // Chromium: no net, with or without `userAgentData` (WebView < 116 has none).
    ['Android WebView 90 (no userAgentData)', { userAgent: UA.androidWebView90 }, false],
    [
      'Android WebView 120',
      { userAgent: UA.androidWebView120, userAgentData: { mobile: true } },
      false,
    ],
    ['Chrome desktop', { userAgent: UA.chromeDesktop, userAgentData: {} }, false],
    ['Chrome desktop without userAgentData', { userAgent: UA.chromeDesktop }, false],
    ['userAgentData alone', { userAgentData: {} }, false],
  ] as const)('%s', (_name, nav, expected) => {
    expect(needsSelectionNet(nav)).toBe(expected);
  });
});
