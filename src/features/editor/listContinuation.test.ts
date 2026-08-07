// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { ChangeSet, Text } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import {
  coalesceRenumberEdits,
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
  const ev = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(ev);
}

function pressTab(view: EditorView, shiftKey = false): void {
  const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey });
  runScopeHandlers(view, ev, 'editor');
}

function pressBackspace(view: EditorView): void {
  const ev = new KeyboardEvent('keydown', {
    key: 'Backspace',
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(ev);
}

describe('blockquote exit', () => {
  it('replaces `> ` with a leading newline so the quote is terminated', () => {
    const doc = '> q1\n> q2\n> ';
    const v = setup(doc, doc.length);
    pressEnter(v);

    const expected = '> q1\n> q2\n\n';
    expect(v.state.doc.toString()).toBe(expected);
    expect(v.state.selection.main.head).toBe(expected.length);
  });

  it('pressing Enter on a non-quote line after an exit does not reinject `> `', () => {
    const doc = '> q1\n> q2\n\nb';
    const v = setup(doc, doc.length); // cursor after `b`
    pressEnter(v);

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
  function applyChanges(
    doc: string,
    changes: ReturnType<typeof computeOrderedRenumberChanges>,
  ): string {
    const sorted = [...changes].sort((a, b) => ((b as any).from ?? 0) - ((a as any).from ?? 0));
    let out = doc;
    for (const c of sorted as Array<{ from: number; to: number; insert: string }>) {
      out = out.slice(0, c.from) + c.insert + out.slice(c.to);
    }
    return out;
  }

  it('renumbers contiguous ordered list when a middle item was deleted', () => {
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
    const changes = computeOrderedRenumberChanges(Text.of(doc.split('\n')), [3]);
    expect(applyChanges(doc, changes)).toBe('1. outer\n  1. inner\n  2. inner3\n2. outer2');
  });

  it('returns no changes when numbering is already correct', () => {
    const doc = '1. a\n2. b\n3. c';
    const changes = computeOrderedRenumberChanges(Text.of(doc.split('\n')), [2]);
    expect(changes).toEqual([]);
  });

  it('renumbers a whole pasted list, including across indent and non-list boundaries', () => {
    // Every line affected is what a paste looks like; mixed indents exercise reuse.
    const doc = '9. a\n9. b\n   9. inner\n   9. inner2\n9. c\nplain\n4. d\n4. e';
    const allLines = Array.from({ length: 8 }, (_, index) => index + 1);
    const changes = computeOrderedRenumberChanges(Text.of(doc.split('\n')), allLines);
    expect(applyChanges(doc, changes)).toBe(
      '9. a\n10. b\n   9. inner\n   10. inner2\n9. c\nplain\n4. d\n5. e',
    );
  });

  // Counting reads keeps the bound deterministic instead of racing a wall clock.
  function countLineReads(doc: Text): { doc: Text; reads: () => number } {
    let reads = 0;
    const countingDoc = new Proxy(doc, {
      get(target, property) {
        if (property === 'line') {
          return (lineNumber: number) => {
            reads += 1;
            return target.line(lineNumber);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Text;
    return { doc: countingDoc, reads: () => reads };
  }

  const ITEM_COUNT = 2000;

  function orderedListDoc(): Text {
    return Text.of(Array.from({ length: ITEM_COUNT }, (_, index) => `${index + 1}. item`));
  }

  // Both spacings were quadratic (~2M reads); every-other-line stayed quadratic
  // even after a fix that only reused the immediately preceding line.
  it.each([
    ['every line', (index: number) => index + 1, ITEM_COUNT],
    ['every other line', (index: number) => index * 2 + 1, ITEM_COUNT / 2],
  ])('reads a bounded number of lines when one edit affects %s', (_label, lineAt, count) => {
    const counted = countLineReads(orderedListDoc());
    const affectedLines = Array.from({ length: count }, (_unused, index) => lineAt(index));

    expect(computeOrderedRenumberChanges(counted.doc, affectedLines)).toEqual([]);
    // Do not fix a failure here by raising the multiplier.
    expect(counted.reads()).toBeLessThan(ITEM_COUNT * 10);
    // A rewrite using doc.lineAt/doc.iter would read zero and pass vacuously.
    expect(counted.reads()).toBeGreaterThan(count);
  });
});

describe('coalesceRenumberEdits', () => {
  it.each([
    [['9. a', '9. b', '9. c', '9. d'], 1, '9. a\n10. b\n11. c\n12. d'],
    [['9. a', '9. b', '', '9. c', '9. d'], 2, '9. a\n10. b\n\n9. c\n10. d'],
    [['1. a', '3. b'], 1, '1. a\n2. b'],
  ])('merges within a block and splits on a blank line (%#)', (lines, changeCount, expected) => {
    const doc = Text.of(lines);
    const edits = computeOrderedRenumberChanges(
      doc,
      lines.map((_line, index) => index + 1),
    );
    const coalesced = coalesceRenumberEdits(doc, edits);
    const applyTo = (changes: readonly { from: number; to: number; insert: string }[]) =>
      ChangeSet.of([...changes], doc.length)
        .apply(doc)
        .toString();

    expect(coalesced).toHaveLength(changeCount);
    expect(applyTo(coalesced)).toBe(applyTo(edits));
    expect(applyTo(coalesced)).toBe(expected);
  });
});

describe('orderedListRenumber extension', () => {
  it('dispatches the renumber as one change per block, not one per item', () => {
    // No engine this suite runs charges per change range, so assert the property
    // directly rather than a duration.
    const itemCount = 500;
    const renumberRangeCounts: number[] = [];
    const view = new EditorView({
      doc: Array.from({ length: itemCount }, () => '1. item').join('\n'),
      extensions: [
        markdown(),
        orderedListRenumber,
        EditorView.updateListener.of((update) => {
          for (const transaction of update.transactions) {
            if (!transaction.isUserEvent('input.renumber')) continue;
            let rangeCount = 0;
            transaction.changes.iterChanges(() => {
              rangeCount += 1;
            });
            renumberRangeCounts.push(rangeCount);
          }
        }),
      ],
      parent: document.body,
    });
    views.push(view);

    view.dispatch({ changes: { from: view.state.doc.line(1).to, insert: '!' } });

    // Proves the list really renumbered, so the count below is not vacuous.
    expect(view.state.doc.line(itemCount).text).toBe(`${itemCount}. item`);
    expect(renumberRangeCounts).toEqual([1]);
  });

  it('keeps the caret on the same character when renumbering widens numbers', () => {
    // The caret sits strictly inside the merged span (between the first and last
    // rewritten number), which is where CodeMirror would collapse it to an edge.
    const view = new EditorView({
      doc: '9. a\n9. bbb\n9. c',
      extensions: [markdown(), orderedListRenumber],
      parent: document.body,
    });
    views.push(view);
    const caret = view.state.doc.line(2).from + 4; // the middle 'b'
    view.dispatch({ selection: { anchor: caret } });

    // Edit line 1 so the block renumbers without touching the caret's line.
    view.dispatch({ changes: { from: view.state.doc.line(1).to, insert: 'Z' } });

    expect(view.state.doc.toString()).toBe('9. aZ\n10. bbb\n11. c');
    const head = view.state.selection.main.head;
    expect(view.state.doc.sliceString(head - 1, head + 2)).toBe('bbb');
  });

  it('parks a caret between the digits of a rewritten number after the new digits', () => {
    // The one position that deliberately differs from CodeMirror's own mapping.
    const view = new EditorView({
      doc: '10. a\n10. b\n10. c',
      extensions: [markdown(), orderedListRenumber],
      parent: document.body,
    });
    views.push(view);
    const betweenDigits = view.state.doc.line(2).from + 1; // between '1' and '0'
    view.dispatch({ selection: { anchor: betweenDigits } });

    view.dispatch({ changes: { from: view.state.doc.line(1).to, insert: '!' } });

    expect(view.state.doc.toString()).toBe('10. a!\n11. b\n12. c');
    const head = view.state.selection.main.head;
    expect(view.state.doc.sliceString(head - 2, head + 1)).toBe('11.');
  });

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

describe('prose indent on Enter', () => {
  it('strips leading spaces from the new line', () => {
    const doc = '  hello';
    const v = setup(doc, doc.length);
    pressEnter(v);
    expect(v.state.doc.toString()).toBe('  hello\n');
    expect(v.state.selection.main.head).toBe('  hello\n'.length);
  });

  it('preserves leading tabs on the new line', () => {
    const doc = '\thello';
    const v = setup(doc, doc.length);
    pressEnter(v);
    expect(v.state.doc.toString()).toBe('\thello\n\t');
    expect(v.state.selection.main.head).toBe('\thello\n\t'.length);
  });

  it('preserves only tabs when leading whitespace mixes tabs and spaces', () => {
    const doc = '\t  hello';
    const v = setup(doc, doc.length);
    pressEnter(v);
    expect(v.state.doc.toString()).toBe('\t  hello\n\t');
    expect(v.state.selection.main.head).toBe('\t  hello\n\t'.length);
  });
});

describe('code block escape', () => {
  it('exits a fenced code block when Enter is pressed on an empty line above the closing fence', () => {
    const doc = '```\nfoo\n\n```';
    const v = setup(doc, doc.indexOf('\n```')); // cursor on the empty line before ```
    pressEnter(v);

    expect(v.state.doc.toString()).toBe('```\nfoo\n```');
    const expectedHead = '```\nfoo\n```'.length;
    expect(v.state.selection.main.head).toBe(expectedHead);
  });
});

describe('list backspace: dedent / delete-empty (editor.md)', () => {
  it('deletes an empty bullet item (clears the line)', () => {
    const doc = '- ';
    const v = setup(doc, doc.length); // caret after "- "
    pressBackspace(v);
    expect(v.state.doc.toString()).toBe('');
    expect(v.state.selection.main.head).toBe(0);
  });

  it('deletes an empty ordered item', () => {
    const doc = '1. ';
    const v = setup(doc, doc.length);
    pressBackspace(v);
    expect(v.state.doc.toString()).toBe('');
  });

  it('deletes an empty task item', () => {
    const doc = '- [ ] ';
    const v = setup(doc, doc.length);
    pressBackspace(v);
    expect(v.state.doc.toString()).toBe('');
  });

  it('strips the marker on a top-level bullet when the caret is at content start', () => {
    const doc = '- hello';
    const v = setup(doc, 2); // right after "- "
    pressBackspace(v);
    expect(v.state.doc.toString()).toBe('hello');
    expect(v.state.selection.main.head).toBe(0);
  });

  it('strips the marker on a top-level ordered item at content start', () => {
    const doc = '1. hello';
    const v = setup(doc, 3); // after "1. "
    pressBackspace(v);
    expect(v.state.doc.toString()).toBe('hello');
  });

  it('dedents a space-indented item by one level at content start', () => {
    const doc = '  - hello';
    const v = setup(doc, doc.indexOf('hello')); // content start
    pressBackspace(v);
    expect(v.state.doc.toString()).toBe('- hello');
    expect(v.state.selection.main.head).toBe(2);
  });

  it('dedents a tab-indented item by one tab at content start', () => {
    const doc = '\t- hello';
    const v = setup(doc, doc.indexOf('hello'));
    pressBackspace(v);
    expect(v.state.doc.toString()).toBe('- hello');
  });

  it('does not intercept a mid-content backspace (falls through to default)', () => {
    const doc = '- hello';
    const v = setup(doc, doc.length); // caret at end, not content-start
    pressBackspace(v);
    expect(v.state.doc.toString()).toBe('- hello');
  });

  it('does not intercept on a non-list line', () => {
    const doc = 'plain text';
    const v = setup(doc, 5);
    pressBackspace(v);
    expect(v.state.doc.toString()).toBe('plain text');
  });
});
