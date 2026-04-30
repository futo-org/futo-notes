// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { Text } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import {
  computeOrderedRenumberChanges,
  listContinuationKeymap,
  orderedListRenumber,
} from './listContinuation';

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
  // Dispatch a real DOM keydown so the document-capture listener (where
  // Enter handling now lives — see iOS bypass note in listContinuation.ts)
  // picks it up. The event must originate inside view.contentDOM so the
  // listener's "in this editor" check passes.
  const ev = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true
  });
  view.contentDOM.dispatchEvent(ev);
}

function pressTab(view: EditorView, shiftKey = false): void {
  const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey });
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

describe('blockquote nesting', () => {
  it('Tab on a blockquote line increases quote depth', () => {
    const doc = '> hello';
    const v = setup(doc, doc.length);
    pressTab(v);

    expect(v.state.doc.toString()).toBe('> > hello');
    expect(v.state.selection.main.head).toBe('> > hello'.length);
  });

  it('Tab normalizes compact nested markers while increasing depth', () => {
    const doc = '>> hello';
    const v = setup(doc, doc.length);
    pressTab(v);

    expect(v.state.doc.toString()).toBe('> > > hello');
  });

  it('Shift-Tab on a nested blockquote decreases quote depth', () => {
    const doc = '> > hello';
    const v = setup(doc, doc.length);
    pressTab(v, true);

    expect(v.state.doc.toString()).toBe('> hello');
    expect(v.state.selection.main.head).toBe('> hello'.length);
  });

  it('Shift-Tab on a level-1 blockquote removes the quote marker', () => {
    const doc = '> hello';
    const v = setup(doc, doc.length);
    pressTab(v, true);

    expect(v.state.doc.toString()).toBe('hello');
    expect(v.state.selection.main.head).toBe('hello'.length);
  });

  it('Tab leaves non-quote lines to the default keymaps', () => {
    const doc = 'hello';
    const v = setup(doc, doc.length);
    pressTab(v);

    expect(v.state.doc.toString()).toBe(doc);
  });
});

describe('computeOrderedRenumberChanges', () => {
  function applyChanges(doc: string, changes: ReturnType<typeof computeOrderedRenumberChanges>): string {
    // Apply right-to-left so earlier offsets stay valid.
    const sorted = [...changes].sort((a, b) =>
      ((b as any).from ?? 0) - ((a as any).from ?? 0)
    );
    let out = doc;
    for (const c of sorted as Array<{ from: number; to: number; insert: string }>) {
      out = out.slice(0, c.from) + c.insert + out.slice(c.to);
    }
    return out;
  }

  it('renumbers contiguous ordered list when a middle item was deleted', () => {
    // After the user deleted line 3 (the original `3. thing3`), `4. thing4`
    // is now the third line and should become `3. thing4`.
    const doc = '1. thing\n2. thing2\n4. thing4';
    const changes = computeOrderedRenumberChanges(Text.of(doc.split('\n')), [3]);
    expect(applyChanges(doc, changes)).toBe('1. thing\n2. thing2\n3. thing4');
  });

  it('preserves the starting number of a list', () => {
    const doc = '5. five\n7. seven';
    const changes = computeOrderedRenumberChanges(Text.of(doc.split('\n')), [2]);
    expect(applyChanges(doc, changes)).toBe('5. five\n6. seven');
  });

  it('does not cross indent boundaries', () => {
    const doc = '1. outer\n  1. inner\n  3. inner3\n2. outer2';
    // Touch the inner sublist only.
    const changes = computeOrderedRenumberChanges(Text.of(doc.split('\n')), [3]);
    expect(applyChanges(doc, changes)).toBe('1. outer\n  1. inner\n  2. inner3\n2. outer2');
  });

  it('returns no changes when numbering is already correct', () => {
    const doc = '1. a\n2. b\n3. c';
    const changes = computeOrderedRenumberChanges(Text.of(doc.split('\n')), [2]);
    expect(changes).toEqual([]);
  });
});

describe('orderedListRenumber extension', () => {
  it('fixes numbering after a delete of a middle line', () => {
    const view = new EditorView({
      doc: '1. thing\n2. thing2\n3. thing3\n4. thing4',
      extensions: [markdown(), orderedListRenumber],
      parent: document.body,
    });
    views.push(view);

    const line3 = view.state.doc.line(3);
    view.dispatch({
      changes: { from: line3.from, to: line3.to + 1, insert: '' },
      selection: { anchor: line3.from },
    });

    expect(view.state.doc.toString()).toBe('1. thing\n2. thing2\n3. thing4');
  });

  it('does not act on selection-only transactions', () => {
    const doc = '1. a\n3. b';
    const view = new EditorView({
      doc,
      extensions: [markdown(), orderedListRenumber],
      parent: document.body,
    });
    views.push(view);

    view.dispatch({ selection: { anchor: 0 } });
    expect(view.state.doc.toString()).toBe(doc);
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
