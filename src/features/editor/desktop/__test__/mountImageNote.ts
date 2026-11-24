/* For tests: an editor view (jsdom, the real engine) showing `source`, its images' URLs
 * answered by `urls`, and what it costs to take it down. jsdom has no ResizeObserver or
 * IntersectionObserver: the latter is recorded, so a test can bring pictures near. */
import { vi } from 'vitest';
import { Engine } from '../engine';
import type { ImageUrls } from '../pictureLoading';
import { EditorView } from '../view';
import { loadEngineBuild } from './loadEngineBuild';

export interface ImageNote {
  view: EditorView;
  engine: Engine;
  /** Report every watched element near the pane. */
  bringNear(): void;
  close(): void;
}

export async function mountImageNote(source: string, urls?: ImageUrls): Promise<ImageNote> {
  await loadEngineBuild();
  const watched: Element[] = [];
  let report: ((entries: IntersectionObserverEntry[]) => void) | null = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        report = callback;
      }
      observe(target: Element) {
        watched.push(target);
      }
      unobserve(target: Element) {
        watched.splice(watched.indexOf(target), 1);
      }
      disconnect() {}
    },
  );
  // jsdom measures no text: the caret a frame draws while a test waits finds no box.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const wrap = document.createElement('div');
  document.body.append(wrap);
  const view = new EditorView(wrap, {
    edited() {},
    focusChanged() {},
    compositionEnded() {},
    toolbar() {},
    copyCode: async () => true,
    images: urls,
  });
  view.open(engine);
  view.dom.tabIndex = 0;
  view.focus();
  return {
    view,
    engine,
    bringNear: () =>
      report?.(
        watched.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
      ),
    close: () => {
      view.destroy();
      wrap.remove();
      engine.free();
      vi.unstubAllGlobals();
    },
  };
}
