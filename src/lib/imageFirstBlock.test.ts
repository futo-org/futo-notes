// @vitest-environment jsdom
// Regression lock: an image reference as the VERY FIRST block of a note
// decorates into an ImageWidget like any other position (editor.md
// "Images"). A 2026-07-02 QA pass reported this broken; a browser-level
// re-verification (Chromium + WebKit) showed the widget renders in every
// state — the report misread cursor-line marker reveal (the raw `![](…)`
// is deliberately visible while the cursor sits ON the image line, and in
// a one-line note there is nowhere else for the cursor to go). These tests
// pin the correct behavior so a real first-block regression gets caught.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
