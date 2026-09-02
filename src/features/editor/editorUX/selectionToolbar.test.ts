// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, StateEffect } from '@codemirror/state';
import { showTooltip } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { closeFindEffect, findState, openFindEffect } from '../find/findState';
import { isInsideCode, selectionToolbar } from './selectionToolbar';

function stateFor(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdown()] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

describe('isInsideCode — selection toolbar hides inside code (editor.md)', () => {
  it('is true inside inline code', () => {
    const doc = 'a `code` b';
    expect(isInsideCode(stateFor(doc), doc.indexOf('code') + 1)).toBe(true);
  });

  it('is false in plain prose', () => {
    const doc = 'plain text here';
    expect(isInsideCode(stateFor(doc), 3)).toBe(false);
  });

  it('is true inside a fenced code block', () => {
    const doc = '```\nconst x = 1;\n```';
    expect(isInsideCode(stateFor(doc), doc.indexOf('const') + 2)).toBe(true);
  });
});

describe('selection toolbar vs find (docs/spec/editor.md — Find in note)', () => {
  function toolbarState(doc: string, selection: { anchor: number; head: number }): EditorState {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(selection.anchor, selection.head),
      extensions: [markdown(), findState, selectionToolbar],
    });
    ensureSyntaxTree(state, doc.length, 5000);
    return state;
  }

  function toolbarShown(state: EditorState): boolean {
    return state.facet(showTooltip).some((tooltip) => tooltip !== null);
  }

  const doc = 'cat dog cat fox';

  it('shows for an ordinary single-line selection', () => {
    expect(toolbarShown(toolbarState(doc, { anchor: 0, head: 3 }))).toBe(true);
  });

  it('stays hidden while find is stepping the selection through matches', () => {
    let state = toolbarState(doc, { anchor: 0, head: 0 });
    state = state.update({
      effects: openFindEffect.of({
        query: 'cat',
        anchor: 0,
        returnSelection: state.selection,
        returnScroll: StateEffect.define<null>().of(null),
      }),
      selection: EditorSelection.single(0, 3),
    }).state;
    expect(toolbarShown(state)).toBe(false);

    // Stepping to the next match moves a real selection — still no bubble.
    state = state.update({ selection: EditorSelection.single(8, 11) }).state;
    expect(toolbarShown(state)).toBe(false);
  });

  it('stays hidden for the find-placed selection after find closes', () => {
    let state = toolbarState(doc, { anchor: 0, head: 0 });
    state = state.update({
      effects: openFindEffect.of({
        query: 'cat',
        anchor: 0,
        returnSelection: state.selection,
        returnScroll: StateEffect.define<null>().of(null),
      }),
      selection: EditorSelection.single(0, 3),
    }).state;
    // Escape leaves the selection on the match (editor.md) and closes find.
    state = state.update({ effects: closeFindEffect.of(null) }).state;
    expect(toolbarShown(state)).toBe(false);

    // A NEW selection the user makes afterwards is ordinary again.
    state = state.update({ selection: EditorSelection.single(8, 11) }).state;
    expect(toolbarShown(state)).toBe(true);
  });
});
