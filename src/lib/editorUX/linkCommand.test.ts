// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { toggleCodeInline, toggleLink } from './linkCommand';

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
});

function setup(doc: string, selection?: { anchor: number; head?: number }): EditorView {
  const view = new EditorView({
    doc,
    selection,
    extensions: [markdown()],
    parent: document.body,
  });
  views.push(view);
  return view;
}

function sel(view: EditorView): { from: number; to: number } {
  const r = view.state.selection.main;
  return { from: r.from, to: r.to };
}

describe('toggleCodeInline', () => {
  it('wraps selected text in backticks', () => {
    const v = setup('hello world', { anchor: 0, head: 5 });
    toggleCodeInline(v);
    expect(v.state.doc.toString()).toBe('`hello` world');
    expect(sel(v)).toEqual({ from: 1, to: 6 });
  });

  it('unwraps a backtick-wrapped selection', () => {
    const v = setup('`hello` world', { anchor: 0, head: 7 });
    toggleCodeInline(v);
    expect(v.state.doc.toString()).toBe('hello world');
  });

  it('unwraps when selection is inside but backticks are just outside', () => {
    const v = setup('`hello` world', { anchor: 1, head: 6 });
    toggleCodeInline(v);
    expect(v.state.doc.toString()).toBe('hello world');
  });

  it('inserts empty pair with cursor in middle when no selection', () => {
    const v = setup('ab', { anchor: 1 });
    toggleCodeInline(v);
    expect(v.state.doc.toString()).toBe('a``b');
    expect(sel(v)).toEqual({ from: 2, to: 2 });
  });
});

describe('toggleLink', () => {
  it('wraps selection into [text](url) using provided url', () => {
    const v = setup('hello world', { anchor: 0, head: 5 });
    toggleLink(v, () => 'https://x.test');
    expect(v.state.doc.toString()).toBe('[hello](https://x.test) world');
  });

  it('unwraps when selection is an existing [text](url)', () => {
    const v = setup('pre [foo](http://x) post', { anchor: 4, head: 19 });
    toggleLink(v, () => {
      throw new Error('should not be called on unwrap');
    });
    expect(v.state.doc.toString()).toBe('pre foo post');
  });

  it('inserts empty [](scaffold) when no selection', () => {
    const v = setup('abc', { anchor: 1 });
    toggleLink(v, () => {
      throw new Error('should not be called for empty selection scaffold');
    });
    expect(v.state.doc.toString()).toBe('a[]()bc');
    // Cursor lands between the brackets
    expect(sel(v)).toEqual({ from: 2, to: 2 });
  });

  it('aborts cleanly if getUrl returns null', () => {
    const v = setup('hello', { anchor: 0, head: 5 });
    toggleLink(v, () => null);
    expect(v.state.doc.toString()).toBe('hello');
  });
});
