// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';

import { ImageWidget } from './images';

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
});

/**
 * jsdom has no ResizeObserver and no layout engine, so the two things the
 * widget's footprint logic depends on are stubbed: observer callbacks are
 * captured so a width change can be replayed on demand, and the image's
 * rendered height is faked via `setRenderedHeight`.
 */
const resizeCallbacks: ResizeObserverCallback[] = [];
const disconnectSpy = vi.fn();

function stubResizeObserver(): void {
  resizeCallbacks.length = 0;
  disconnectSpy.mockClear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect = disconnectSpy;
    },
  );
}

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setRenderedHeight(img: HTMLImageElement, height: number, width = 300): void {
  Object.defineProperty(img, 'offsetHeight', { value: height, configurable: true });
  Object.defineProperty(img, 'offsetWidth', { value: width, configurable: true });
}

function replayWidthChange(): void {
  for (const callback of resizeCallbacks) {
    callback([], {} as ResizeObserver);
  }
}

function setupImageWidgetView(source = 'photo.png'): {
  view: EditorView;
  img: HTMLImageElement;
  wrapper: HTMLElement;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);

  // A minimal plugin that renders exactly one ImageWidget, standing in for the
  // real decoration built by decorateImage() in inlineDecorations.ts.
  const imagePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(editorView: EditorView) {
        const end = editorView.state.doc.length;
        this.decorations = Decoration.set([
          Decoration.replace({ widget: new ImageWidget('alt text', source, end) }).range(0, end),
        ]);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  const view = new EditorView({
    state: EditorState.create({ doc: `![alt text](${source})`, extensions: [imagePlugin] }),
    parent: container,
  });
  views.push(view);

  const img = view.contentDOM.querySelector('.cm-md-image-wrapper img') as HTMLImageElement;
  return { view, img, wrapper: img.parentElement as HTMLElement };
}

describe('ImageWidget', () => {
  it('asks CodeMirror to re-measure once the image finishes loading', () => {
    const { view, img } = setupImageWidgetView('measure-on-load.png');
    const requestMeasure = vi.spyOn(view, 'requestMeasure');
    setRenderedHeight(img, 240);

    // jsdom never actually fetches image bytes, so simulate the async load
    // completing the same way a real (slow, native-bridge-backed) image load
    // would: firing a 'load' event on the <img> once bytes arrive.
    img.dispatchEvent(new Event('load'));

    expect(requestMeasure).toHaveBeenCalled();
  });

  it('commits the loaded image footprint as a min-height floor, replacing the placeholder', () => {
    const { img, wrapper } = setupImageWidgetView('commit-footprint.png');

    // Before load: an uncached image reserves only the placeholder floor — this
    // is the "cut off on first paint" state the original bug got stuck in.
    expect(wrapper.style.minHeight).toBe('200px');

    setRenderedHeight(img, 240);
    img.dispatchEvent(new Event('load'));

    // After load the widget reserves the measured footprint. It must be a floor,
    // never a pinned `height`: `height` + the wrapper's `overflow: hidden` is
    // what clipped the image when the editor later got wider.
    expect(wrapper.style.minHeight).toBe('240px');
    expect(wrapper.style.height).toBe('');
  });

  it('grows the reserved height when a width change makes the image taller', () => {
    const { view, img, wrapper } = setupImageWidgetView('width-change.png');
    setRenderedHeight(img, 240);
    img.dispatchEvent(new Event('load'));
    expect(wrapper.style.minHeight).toBe('240px');

    // A wider editor (device rotation, or the iOS shared WebView adopting real
    // bounds after its zero-size prewarm) makes a width-constrained image
    // taller. Nothing fires a load event and no transaction is dispatched.
    const requestMeasure = vi.spyOn(view, 'requestMeasure');
    setRenderedHeight(img, 410, 520);
    replayWidthChange();

    expect(wrapper.style.minHeight).toBe('410px');
    expect(wrapper.style.height).toBe('');
    // CM6's height map has to follow, or scrolling past the image jerks.
    expect(requestMeasure).toHaveBeenCalled();
  });

  it('ignores a zero-height measurement taken before the host has laid out', () => {
    const { img, wrapper } = setupImageWidgetView('zero-height.png');

    // The iOS editor WebView is prewarmed at zero size, so an image can load
    // before the host has any width. Committing that measurement would pin a
    // zero floor and poison the shared size cache for every later widget.
    setRenderedHeight(img, 0, 0);
    img.dispatchEvent(new Event('load'));

    expect(wrapper.style.minHeight).toBe('200px');
    expect(wrapper.style.height).toBe('');
  });

  it('stops observing the image once the widget is destroyed', () => {
    const { view } = setupImageWidgetView('destroy.png');

    // The widget the view built is internal to CM6, so drive a second one over
    // the same view: destroy() must release the observer it created in toDOM.
    const widget = new ImageWidget('alt text', 'destroy-second.png', 0);
    widget.toDOM(view);
    widget.destroy();

    expect(disconnectSpy).toHaveBeenCalled();
  });
});
