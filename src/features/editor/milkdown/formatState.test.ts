import { describe, expect, it } from 'vitest';

import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';

import { computeActiveFormats } from './formatState';
import { testSchema } from './__fixtures__/schema';

const s = testSchema;

/**
 * `computeActiveFormats` reads `view.state.schema` and `view.state.doc` and
 * nothing else, so a state stub is the whole view it needs.
 */
function stubView(doc: ProseNode): ProseView {
  return { state: EditorState.create({ doc }) } as unknown as ProseView;
}

/** The caret at the first text position inside the `index`-th top-level child. */
function caretIn(doc: ProseNode, index: number): TextSelection {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
  return TextSelection.create(doc, pos + 2);
}

function activeAt(doc: ProseNode, index: number): string[] {
  return computeActiveFormats(stubView(doc), caretIn(doc, index), null).sort();
}

describe('computeActiveFormats', () => {
  it('reports nothing for a caret in a plain paragraph', () => {
    const doc = s.nodes.doc.create(null, s.nodes.paragraph.create(null, s.text('plain')));
    expect(activeAt(doc, 0)).toEqual([]);
  });

  it('reports the block kind at the caret', () => {
    const heading = s.nodes.doc.create(null, s.nodes.heading.create({ level: 2 }, s.text('title')));
    expect(activeAt(heading, 0)).toEqual(['heading']);

    const quote = s.nodes.doc.create(
      null,
      s.nodes.blockquote.create(null, s.nodes.paragraph.create(null, s.text('quoted'))),
    );
    expect(computeActiveFormats(stubView(quote), TextSelection.create(quote, 3), null)).toEqual([
      'quote',
    ]);
  });

  it('reports the marks covering a collapsed caret', () => {
    const doc = s.nodes.doc.create(
      null,
      s.nodes.paragraph.create(null, s.text('bold', [s.marks.strong.create()])),
    );
    expect(activeAt(doc, 0)).toEqual(['bold']);
  });

  // A PARTLY bold selection reports bold, because that is what tapping the
  // button will do to it: prosemirror-commands' toggleMark branches on the
  // same "occurs anywhere" test and removes the mark.
  it('reports a mark that occurs anywhere in a range', () => {
    const doc = s.nodes.doc.create(
      null,
      s.nodes.paragraph.create(null, [s.text('bold', [s.marks.strong.create()]), s.text(' plain')]),
    );
    const view = stubView(doc);

    expect(computeActiveFormats(view, TextSelection.create(doc, 1, 5), null)).toEqual(['bold']);
    expect(computeActiveFormats(view, TextSelection.create(doc, 1, 8), null)).toEqual(['bold']);
    // …and not at all when the range misses the mark entirely.
    expect(computeActiveFormats(view, TextSelection.create(doc, 6, 10), null)).toEqual([]);
  });

  // `storedMarks` is what makes a toolbar tap light up immediately: toggling
  // Bold on a collapsed caret sets a stored mark and changes no text.
  it('honours storedMarks for a collapsed caret', () => {
    const doc = s.nodes.doc.create(null, s.nodes.paragraph.create(null, s.text('plain')));
    const view = stubView(doc);
    const caret = TextSelection.create(doc, 2);

    expect(computeActiveFormats(view, caret, null)).toEqual([]);
    expect(computeActiveFormats(view, caret, [s.marks.emphasis.create()])).toEqual(['italic']);
  });

  it('reports task-list and NOT bullet-list inside a checkbox item', () => {
    const item = s.nodes.list_item.create(
      { checked: false },
      s.nodes.paragraph.create(null, s.text('todo')),
    );
    const doc = s.nodes.doc.create(null, s.nodes.bullet_list.create(null, item));

    // Caret inside the item's paragraph: doc > bullet_list > list_item > p.
    const active = computeActiveFormats(stubView(doc), TextSelection.create(doc, 4), null);
    expect(active).toEqual(['task-list']);
  });

  it('reports bullet-list inside a plain bullet item', () => {
    const item = s.nodes.list_item.create(null, s.nodes.paragraph.create(null, s.text('point')));
    const doc = s.nodes.doc.create(null, s.nodes.bullet_list.create(null, item));

    expect(computeActiveFormats(stubView(doc), TextSelection.create(doc, 4), null)).toEqual([
      'bullet-list',
    ]);
  });

  it('reports ordered-list inside a numbered item', () => {
    const item = s.nodes.list_item.create(null, s.nodes.paragraph.create(null, s.text('one')));
    const doc = s.nodes.doc.create(null, s.nodes.ordered_list.create(null, item));

    expect(computeActiveFormats(stubView(doc), TextSelection.create(doc, 4), null)).toEqual([
      'ordered-list',
    ]);
  });

  it('combines a mark and its enclosing block', () => {
    const doc = s.nodes.doc.create(
      null,
      s.nodes.heading.create({ level: 1 }, s.text('big', [s.marks.strike_through.create()])),
    );
    expect(activeAt(doc, 0)).toEqual(['heading', 'strikethrough']);
  });

  it('ignores a mark the schema does not have', () => {
    // The commonmark preset alone has no strike_through; a missing mark type
    // must read as "not active", never throw.
    const bare = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'inline*' },
        text: { group: 'inline' },
      },
      marks: {},
    });
    const doc = bare.nodes.doc.create(null, bare.nodes.paragraph.create(null, bare.text('x')));
    expect(
      computeActiveFormats(
        { state: EditorState.create({ doc }) } as unknown as ProseView,
        TextSelection.create(doc, 2),
        null,
      ),
    ).toEqual([]);
  });
});
