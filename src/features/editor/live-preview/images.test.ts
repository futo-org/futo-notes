// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';

import { ImageWidget } from './images';

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
});

function setupImageWidgetView(): { view: EditorView; img: HTMLImageElement } {
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
          Decoration.replace({ widget: new ImageWidget('alt text', 'photo.png', end) }).range(
            0,
            end,
          ),
        ]);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  const view = new EditorView({
    state: EditorState.create({ doc: '![alt text](photo.png)', extensions: [imagePlugin] }),
    parent: container,
  });
  views.push(view);

  const img = view.contentDOM.querySelector('.cm-md-image-wrapper img') as HTMLImageElement;
  return { view, img };
}

describe('ImageWidget', () => {
  it('asks CodeMirror to re-measure once the image finishes loading', () => {
    const { view, img } = setupImageWidgetView();
    const requestMeasure = vi.spyOn(view, 'requestMeasure');

    // jsdom never actually fetches image bytes, so simulate the async load
    // completing the same way a real (slow, native-bridge-backed) image load
    // would: firing a 'load' event on the <img> once bytes arrive.
    img.dispatchEvent(new Event('load'));

    expect(requestMeasure).toHaveBeenCalled();
  });
});
