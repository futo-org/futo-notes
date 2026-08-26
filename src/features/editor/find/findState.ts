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
 * The visible box, in viewport px, the editor actually scrolls in —
 * `cm-scroller` when the editor scrolls itself, otherwise the pane the shell
 * scrolls it inside of. Mirrors the ancestor walk CodeMirror's own
 * `scrollRectIntoView` performs.
 */
function scrollportRect(view: EditorView): { top: number; bottom: number } {
  for (let element: HTMLElement | null = view.scrollDOM; element; element = element.parentElement) {
    if (element.scrollHeight > element.clientHeight) {
      const { top } = element.getBoundingClientRect();
      return { top, bottom: top + element.clientHeight };
    }
  }
  return { top: 0, bottom: view.dom.ownerDocument.defaultView?.innerHeight ?? 0 };
}

/**
 * How much of that scrollport the editor's OWN find panel paints over. The
 * desktop bar is sticky-docked inside the scrolling pane, so it covers the
 * bottom strip rather than shrinking it — exactly the geometry the native bars
 * declare through {@link setFindOverlayInset}, only measurable from here. A
 * bar laid out below the scrollport overlaps by 0 and changes nothing.
 */
function measurePanelOverlay(view: EditorView, panelDom: HTMLElement | null): number {
  if (!panelDom?.isConnected) return 0;
  const panel = panelDom.getBoundingClientRect();
  if (panel.height <= 0) return 0;
  return Math.max(0, Math.min(scrollportRect(view).bottom, panel.bottom) - panel.top);
}

/**
 * The bottom scroll margin CodeMirror's reveal must respect while find is
 * open. Registered on `EditorView.scrollMargins` by the find extension, so
 * every find reveal — open, query change, and each step — clears whatever
 * covers the pane's bottom strip: the height a native host declared, the
 * desktop panel's own measured height, whichever is larger. Measured on every
 * read rather than latched, so a window resize needs no re-declaration.
 * `null` (nothing covering the viewport) is exactly the pre-find behavior.
 */
export function findScrollMargin(
  view: EditorView,
  panelDom: HTMLElement | null = null,
): { bottom: number } | null {
  const value = view.state.field(findState, false);
  if (!value?.open) return null;
  const bottom = Math.max(value.bottomOverlayPx, measurePanelOverlay(view, panelDom));
  return bottom > 0 ? { bottom } : null;
}

/** Where the current match sits relative to the area a reveal may use. */
export interface FindRevealCheck {
  /** True when the match hangs below the overlay or above the scrollport. */
  readonly clipped: boolean;
  readonly match: FindMatch;
}

/**
 * Re-measure the current match against the reveal area, AFTER the reveal.
 *
 * CodeMirror computes its scroll from the coordinates a position has at the
 * moment it scrolls — but a match inside markdown the live preview hides (a
 * `[label](url)` URL) only takes its real place once the line reveals, which
 * is a relayout later. The line then reflows downward and drops the match back
 * under the overlay the scroll had just cleared. The engine therefore re-reads
 * the match after the relayout and re-reveals it (findExtension), which is
 * platform-independent: every host whose bar overlays the pane needs it.
 *
 * Reads layout, so it belongs in a `requestMeasure` read — never inside an
 * update, where CodeMirror refuses layout reads. `null` means there is nothing
 * to judge yet (find closed, no current match, or the match is not rendered).
 */
export function checkFindReveal(
  view: EditorView,
  panelDom: HTMLElement | null = null,
): FindRevealCheck | null {
  const value = view.state.field(findState, false);
  const match = value?.open ? value.matches[value.currentIndex] : undefined;
  if (!match) return null;
  const start = view.coordsAtPos(match.from);
  const end = view.coordsAtPos(match.to);
  if (!start || !end) return null;
  const port = scrollportRect(view);
  const margin = findScrollMargin(view, panelDom)?.bottom ?? 0;
  const clipped =
    Math.max(start.bottom, end.bottom) > port.bottom - margin + 0.5 ||
    Math.min(start.top, end.top) < port.top - 0.5;
  return { clipped, match };
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
