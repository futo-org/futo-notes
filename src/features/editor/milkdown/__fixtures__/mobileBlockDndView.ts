import { vi } from 'vitest';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EditorState, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { type MobileBlockDndOptions } from '../mobileBlockDnd';
import { testSchema } from '../__fixtures__/schema';

export const s = testSchema;

/** Real user-agent strings, by engine. */
export const UA = {
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

export const BLOCK_TOP = 100;
export const BLOCK_HEIGHT = 40;
export const BLOCK_LEFT = 24;
export const BLOCK_WIDTH = 300;
export const BLOCK_X = BLOCK_LEFT + BLOCK_WIDTH / 2;

export function paragraph(text: string): ProseNode {
  return s.nodes.paragraph.create(null, s.text(text));
}

export function rectAt(top: number, bottom: number): DOMRect {
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
export function makeView(hasFocus: boolean, empty = false) {
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
    /** Center of the block, where a real touch would land. */
    pointA: { x: BLOCK_X, y: BLOCK_TOP + BLOCK_HEIGHT / 2 },
  };
}

export function pointerEvent(
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

export function makeOptions(): {
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
