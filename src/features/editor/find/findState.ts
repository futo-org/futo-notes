import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import { EditorView, type Command } from '@codemirror/view';

import {
  findCurrentMatchIndex,
  findMatches,
  wrapFindMatchIndex,
  type FindMatch,
} from './findMatches';

export interface FindStateValue {
  open: boolean;
  query: string;
  matches: readonly FindMatch[];
  currentIndex: number;
  anchor: number;
  returnSelection: EditorSelection | null;
  returnScroll: StateEffect<unknown> | null;
}

export const openFindEffect = StateEffect.define<{
  query: string;
  anchor: number;
  returnSelection: EditorSelection;
  returnScroll: StateEffect<unknown>;
}>();
export const closeFindEffect = StateEffect.define<null>();
export const setFindQueryEffect = StateEffect.define<string>();
export const setFindResultsEffect = StateEffect.define<{
  matches: readonly FindMatch[];
  currentIndex: number;
  anchor?: number;
}>();
export const requestFindFocusEffect = StateEffect.define<null>();

const initialFindState: FindStateValue = {
  open: false,
  query: '',
  matches: [],
  currentIndex: -1,
  anchor: 0,
  returnSelection: null,
  returnScroll: null,
};

export const findState = StateField.define<FindStateValue>({
  create: () => initialFindState,
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged && value.open) {
      next = {
        ...next,
        matches: [],
        currentIndex: -1,
        anchor: transaction.changes.mapPos(value.anchor),
        returnSelection: value.returnSelection?.map(transaction.changes) ?? null,
        returnScroll: value.returnScroll?.map(transaction.changes) ?? null,
      };
    }
    for (const effect of transaction.effects) {
      if (effect.is(openFindEffect)) {
        next = { ...next, open: true, ...effect.value };
      } else if (effect.is(closeFindEffect)) {
        next = {
          ...next,
          open: false,
          matches: [],
          currentIndex: -1,
          returnSelection: null,
          returnScroll: null,
        };
      } else if (effect.is(setFindQueryEffect)) {
        next = { ...next, query: effect.value, matches: [], currentIndex: -1 };
      } else if (effect.is(setFindResultsEffect)) {
        next = { ...next, ...effect.value };
      }
    }
    return next;
  },
});

export function scanFindResults(view: EditorView, selectMatch: boolean): void {
  const value = view.state.field(findState);
  if (!value.open) return;
  const matches = findMatches(view.state.doc, value.query);
  const currentIndex = findCurrentMatchIndex(matches, { from: value.anchor, to: value.anchor });
  const current = matches[currentIndex];
  view.dispatch({
    effects: setFindResultsEffect.of({
      matches,
      currentIndex,
      anchor: current?.from ?? value.anchor,
    }),
    selection: selectMatch && current ? { anchor: current.from, head: current.to } : undefined,
    scrollIntoView: Boolean(selectMatch && current),
  });
}

export const openFind: Command = (view) => {
  const value = view.state.field(findState);
  const selection = view.state.selection.main;
  const query = selection.empty ? value.query : view.state.sliceDoc(selection.from, selection.to);
  const matches = findMatches(view.state.doc, query);
  const currentIndex = findCurrentMatchIndex(matches, selection);
  const current = matches[currentIndex];
  const returnSelection = value.returnSelection ?? view.state.selection;
  const returnScroll = value.returnScroll ?? view.scrollSnapshot();
  view.dispatch({
    effects: [
      openFindEffect.of({ query, anchor: selection.from, returnSelection, returnScroll }),
      setFindResultsEffect.of({ matches, currentIndex }),
      requestFindFocusEffect.of(null),
    ],
    selection: current ? { anchor: current.from, head: current.to } : undefined,
    scrollIntoView: Boolean(current),
  });
  return true;
};

export function closeFind(view: EditorView, returnFocus = false, restoreOrigin = false): boolean {
  const value = view.state.field(findState);
  if (!value.open) return false;
  view.dispatch({
    effects: [
      closeFindEffect.of(null),
      ...(restoreOrigin && value.returnScroll ? [value.returnScroll] : []),
    ],
    selection: restoreOrigin && value.returnSelection ? value.returnSelection : undefined,
  });
  if (returnFocus) view.focus();
  return true;
}

export function setFindQuery(view: EditorView, query: string): boolean {
  if (!view.state.field(findState).open) return false;
  view.dispatch({ effects: setFindQueryEffect.of(query) });
  return true;
}

export function stepFind(view: EditorView, direction: 1 | -1): boolean {
  const value = view.state.field(findState);
  if (!value.open || !value.query) return false;
  const matches = findMatches(view.state.doc, value.query);
  if (matches.length === 0) {
    view.dispatch({ effects: setFindResultsEffect.of({ matches, currentIndex: -1 }) });
    return false;
  }

  const selectedIndex = matches.findIndex(
    (match) =>
      match.from === view.state.selection.main.from && match.to === view.state.selection.main.to,
  );
  const nextIndex = findCurrentMatchIndex(matches, view.state.selection.main);
  const currentIndex = wrapFindMatchIndex(
    selectedIndex >= 0 ? selectedIndex + direction : nextIndex + (direction === -1 ? -1 : 0),
    matches.length,
  );
  const current = matches[currentIndex];
  view.dispatch({
    effects: setFindResultsEffect.of({ matches, currentIndex, anchor: current.from }),
    selection: { anchor: current.from, head: current.to },
    scrollIntoView: true,
  });
  return true;
}
