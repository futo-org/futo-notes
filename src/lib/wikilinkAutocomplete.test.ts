// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import type { Completion } from '@codemirror/autocomplete';
import { makeApply } from './wikilinkAutocomplete';

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
});

function setup(doc: string, anchor: number): EditorView {
  const view = new EditorView({
    doc,
    selection: { anchor },
    extensions: [markdown()],
    parent: document.body,
  });
  views.push(view);
  return view;
}

// The completion `from`/`to` bracket the text typed after `[[` (the query),
// which `apply` replaces with the full path + closing `]]`.
const stub = {} as Completion;

describe('wikilink autocomplete apply', () => {
  it('drops the caret AFTER the ]] regardless of where it sat (regression: caret stranded inside the link)', () => {
    // A bare `changes` dispatch maps a caret that is NOT exactly at the query
    // end to the FRONT of the inserted text (`[[|Grocery list]]`) — CM's default
    // mapping. `apply` must therefore place the selection explicitly. Put the
    // caret at `from` (the worst case) so this fails without the explicit
    // selection and passes with it.
    const view = setup('[[Gro', 2);

    makeApply('Grocery list')(view, stub, 2, 5);

    expect(view.state.doc.toString()).toBe('[[Grocery list]]');
    const sel = view.state.selection.main;
    expect(sel.empty).toBe(true);
    expect(sel.head).toBe('[[Grocery list]]'.length); // [[Grocery list]]|
  });

  it('inserts the full path even when the dropdown showed a shorter suffix', () => {
    const view = setup('[[Road', 6);

    makeApply('Projects/Roadmap')(view, stub, 2, 6);

    expect(view.state.doc.toString()).toBe('[[Projects/Roadmap]]');
    expect(view.state.selection.main.head).toBe('[[Projects/Roadmap]]'.length);
  });

  it('keeps trailing text after the link and drops the caret before it', () => {
    // `[[Gro and more`, caret at the query end (5); text after `to` stays put.
    const view = setup('[[Gro and more', 5);

    makeApply('Grocery list')(view, stub, 2, 5);

    expect(view.state.doc.toString()).toBe('[[Grocery list]] and more');
    // Caret sits immediately after `]]`, before the surviving ` and more`.
    expect(view.state.selection.main.head).toBe('[[Grocery list]]'.length);
  });
});
