// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { markdownEditorLanguageExtensions } from './codeMirrorMarkdown';
import { liveMarkdownTransform } from './liveMarkdownTransform';

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
});

function setup(doc: string): EditorView {
  const view = new EditorView({
    doc,
    extensions: [...markdownEditorLanguageExtensions(), liveMarkdownTransform],
    parent: document.body,
  });
  views.push(view);
  return view;
}

function hasImageWidget(view: EditorView): boolean {
  const plugin: any = view.plugin(liveMarkdownTransform);
  const cur = plugin.decorations.iter();
  while (cur.value) {
    if (cur.value.spec?.widget?.constructor?.name === 'ImageWidget') return true;
    cur.next();
  }
  return false;
}

describe('image as first block', () => {
  it('renders a widget when text follows and the cursor is elsewhere', () => {
    const view = setup('![](x.png)\nbelow');
    view.contentDOM.focus();
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    expect(hasImageWidget(view)).toBe(true);
  });

  it('renders a widget when typed into an empty doc followed by Enter', () => {
    const view = setup('');
    view.contentDOM.focus();
    view.dispatch({ changes: { from: 0, insert: '![](x.png)\n' }, selection: { anchor: 11 } });
    expect(hasImageWidget(view)).toBe(true);
  });

  it('control: renders with text above', () => {
    const view = setup('hello\n![](x.png)');
    view.contentDOM.focus();
    view.dispatch({ selection: { anchor: 0 } });
    expect(hasImageWidget(view)).toBe(true);
  });
});
