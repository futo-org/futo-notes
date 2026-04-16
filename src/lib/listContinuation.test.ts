// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { listContinuationKeymap } from './listContinuation';

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
});

function setup(doc: string, anchor: number): EditorView {
  const view = new EditorView({
    doc,
    selection: { anchor },
    extensions: [markdown(), listContinuationKeymap],
    parent: document.body,
  });
  views.push(view);
  return view;
}

function pressEnter(view: EditorView): void {
  const ev = new KeyboardEvent('keydown', { key: 'Enter' });
  runScopeHandlers(view, ev, 'editor');
}

describe('blockquote exit', () => {
  it('replaces `> ` with a leading newline so the quote is terminated', () => {
    // Scenario: user is on `> ` (empty content) and hits Enter
    const doc = '> q1\n> q2\n> ';
    const v = setup(doc, doc.length);
    pressEnter(v);

    // The empty `> ` gets replaced with `\n` so the next typed content is
    // visually separated from the quote (blank line between them).
    const expected = '> q1\n> q2\n\n';
    expect(v.state.doc.toString()).toBe(expected);
    // Cursor lands on the now-empty line 4 (after the new `\n`)
    expect(v.state.selection.main.head).toBe(expected.length);
  });

  it('pressing Enter on a non-quote line after an exit does not reinject `> `', () => {
    // Exit from a blockquote, type a char, Enter — the next line should be plain.
    // This guards against lazy-continuation accidentally putting `> ` back in.
    const doc = '> q1\n> q2\n\nb';
    const v = setup(doc, doc.length); // cursor after `b`
    pressEnter(v);

    // Our handler returns false (no quote/list match). Whatever default runs,
    // it must NOT inject a `> ` — that's the regression we're guarding against.
    expect(v.state.doc.toString()).not.toContain('b\n>');
  });
});

describe('code block escape', () => {
  it('exits a fenced code block when Enter is pressed on an empty line above the closing fence', () => {
    const doc = '```\nfoo\n\n```';
    const v = setup(doc, doc.indexOf('\n```')); // cursor on the empty line before ```
    pressEnter(v);

    // Cursor should land after the closing fence, on the same line
    expect(v.state.doc.toString()).toBe('```\nfoo\n```');
    const expectedHead = '```\nfoo\n```'.length;
    expect(v.state.selection.main.head).toBe(expectedHead);
  });
});
