import { EditorSelection, StateEffect, StateField, type EditorState } from '@codemirror/state';
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
  /**
   * Height, in CSS px, of host chrome drawn OVER the editor's bottom edge —
   * the native find bars (see {@link setFindOverlayInset}). 0 means nothing
   * covers the viewport, which is every host that never reports one.
   */
  bottomOverlayPx: number;
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
export const setFindOverlayInsetEffect = StateEffect.define<number>();

const initialFindState: FindStateValue = {
  open: false,
  query: '',
  matches: [],
  currentIndex: -1,
  anchor: 0,
  returnSelection: null,
  returnScroll: null,
  bottomOverlayPx: 0,
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
      } else if (effect.is(setFindOverlayInsetEffect)) {
        next = { ...next, bottomOverlayPx: effect.value };
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

/**
 * Report the height, in CSS px, of host chrome drawn OVER the editor's bottom
 * edge — the native find bars, which the shells dock above the keyboard on top
 * of a WebView that extends underneath them. Without it a match revealed flush
 * with the viewport bottom lands under the bar, and docs/spec/editor.md
 * requires the CURRENT match to be visible.
 *
 * The value is latched, so a host reports it once per size change rather than
 * on every open, and it stays put across close. Declaring it while find is
 * already open re-reveals the current match against the new margin: a shell
 * only learns its bar's height once the bar has been laid out, which is a
 * frame after the `openFind` that made it appear.
 */
export function setFindOverlayInset(view: EditorView, bottomOverlayPx: number): boolean {
  const value = view.state.field(findState);
  const next = Number.isFinite(bottomOverlayPx) ? Math.max(0, bottomOverlayPx) : 0;
  if (next === value.bottomOverlayPx) return false;
  const current = value.open ? value.matches[value.currentIndex] : undefined;
  view.dispatch({
    effects: [
      setFindOverlayInsetEffect.of(next),
      ...(current
        ? [EditorView.scrollIntoView(EditorSelection.range(current.from, current.to))]
        : []),
    ],
  });
  return true;
}

/**
 * The bottom scroll margin CodeMirror's reveal must respect while find is
 * open. Registered on `EditorView.scrollMargins` by the find extension, so
 * every find reveal — open, query change, and each step — clears the host's
 * overlay. `null` (no host overlay) is exactly the pre-existing behavior.
 */
export function findScrollMargin(state: EditorState): { bottom: number } | null {
  const value = state.field(findState, false);
  if (!value?.open || value.bottomOverlayPx <= 0) return null;
  return { bottom: value.bottomOverlayPx };
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
