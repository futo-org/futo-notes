/*
 * Find in note — the ProseMirror half of the shared engine.
 *
 * Replaces the CodeMirror `findState.ts` + `findDecorations.ts` pair (commit
 * 8e902802, issue #26). The behavior is the spec's, unchanged: case-insensitive
 * literal matching, a current match tracked across edits, next/previous with
 * wrap, every match highlighted with the current one distinct, and the current
 * match always scrolled clear of whatever bar covers the bottom of the
 * viewport.
 *
 * TYPING IS SACRED (AGENTS.md M5). Nothing here scans the document on the input
 * path. A transaction only MAPS what it already holds — the decoration set
 * through `DecorationSet.map`, the match list and the anchor through
 * `tr.mapping` — and marks a rescan pending. The rescan itself runs one
 * animation frame later, so the count may lag an edit by a frame, which
 * docs/spec/editor.md explicitly allows.
 *
 * Only a QUERY change moves the user's selection to a match. A body edit
 * rescans silently: selecting there would redirect the next keystroke into a
 * match the user never asked to jump to. That is `pendingSelect`, and it is the
 * `selectMatch` flag main's `scheduleScan` threaded, kept.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView as ProseView } from '@milkdown/kit/prose/view';

import {
  createFindMatchReport,
  findCurrentMatchIndex,
  findDocMatches,
  wrapFindMatchIndex,
  type FindMatch,
  type FindMatchReport,
} from './findMatches';

/** Class on every match; the current one also carries `FIND_CURRENT_CLASS`. */
export const FIND_MATCH_CLASS = 'futo-find-match';
export const FIND_CURRENT_CLASS = 'futo-find-match-current';

/** Breathing room above and below a revealed match, on top of any bar inset. */
const REVEAL_PADDING_PX = 8;

export const findPluginKey = new PluginKey<FindPluginState>('FUTO_FIND');

/** Selection and scroll from before find opened, for a close that restores it. */
interface FindOrigin {
  anchor: number;
  head: number;
  scroller: Element | null;
  scrollTop: number;
}

export interface FindPluginState {
  open: boolean;
  query: string;
  matches: readonly FindMatch[];
  currentIndex: number;
  decorations: DecorationSet;
  /** Document position the "nearest match" search anchors on. */
  anchor: number;
  origin: FindOrigin | null;
  /** A rescan is due, so `matches` is up to one frame stale. */
  scanPending: boolean;
  /** That rescan should also select its match (a query change, not an edit). */
  pendingSelect: boolean;
  /** Pixels covered at the bottom of the editor viewport by a find bar. */
  overlayInset: number;
  /**
   * The range a close left the selection sitting on.
   *
   * Desktop's Escape leaves the selection on the current match, and the
   * floating selection toolbar must not pop up for it (docs/spec/editor.md):
   * the user pressed Escape to get find's chrome OFF the screen, not to swap it
   * for another bar. Cleared by any edit, and outvoted by any selection the
   * user makes for themselves, because the gate compares this against the LIVE
   * selection rather than latching.
   */
  quietSelection: { from: number; to: number } | null;
}

type FindAction =
  | { type: 'open'; query: string; anchor: number; origin: FindOrigin }
  | { type: 'close'; quiet: { from: number; to: number } | null }
  | { type: 'setQuery'; query: string }
  | { type: 'results'; matches: readonly FindMatch[]; currentIndex: number; anchor: number }
  | { type: 'inset'; px: number };

const EMPTY: FindPluginState = {
  open: false,
  query: '',
  matches: [],
  currentIndex: -1,
  decorations: DecorationSet.empty,
  anchor: 0,
  origin: null,
  scanPending: false,
  pendingSelect: false,
  overlayInset: 0,
  quietSelection: null,
};

const matchSpec = { class: FIND_MATCH_CLASS };
const currentSpec = { class: `${FIND_MATCH_CLASS} ${FIND_CURRENT_CLASS}` };

/**
 * Decorations for every match, with the current one marked.
 *
 * Deliberately NOT viewport-only. CodeMirror's find decorated only the visible
 * ranges because a CM6 `ViewPlugin` rebuilds its whole `Decoration.set` on every
 * viewport change, so a document-wide set there is paid for on every scroll.
 * ProseMirror's `DecorationSet` is a persistent tree that MAPS through a
 * transaction instead of being rebuilt, and its `decorations` prop is not
 * viewport-driven — so the document-wide set is paid for once per rescan and
 * mapped thereafter. Measured before choosing it; numbers are in the commit
 * body.
 */
export function buildFindDecorations(
  doc: ProseNode,
  matches: readonly FindMatch[],
  currentIndex: number,
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, index === currentIndex ? currentSpec : matchSpec),
    ),
  );
}

export function getFindState(state: EditorState): FindPluginState {
  return findPluginKey.getState(state) ?? EMPTY;
}

/** Whether find currently owns the editor — the gate other surfaces read. */
export function isFindOpen(state: EditorState): boolean {
  return getFindState(state).open;
}

/**
 * Whether the desktop selection toolbar must stay down: find is open, or the
 * live selection is still the one find's close left behind.
 */
export function findSuppressesSelectionToolbar(state: EditorState): boolean {
  const find = getFindState(state);
  if (find.open) return true;
  const quiet = find.quietSelection;
  if (!quiet) return false;
  return state.selection.from === quiet.from && state.selection.to === quiet.to;
}

export interface FindPluginOptions {
  /** Every recomputation and every step, deduped. Drives the native bars. */
  onMatches?: (report: FindMatchReport) => void;
  /** Anything the desktop panel renders (open/closed, query, count). */
  onStateChange?: (state: FindPluginState) => void;
}

export function createFindPlugin(options: FindPluginOptions = {}): Plugin<FindPluginState> {
  return new Plugin<FindPluginState>({
    key: findPluginKey,
    state: {
      init: () => EMPTY,
      apply(tr, value): FindPluginState {
        let next = value;
        if (tr.docChanged && value.open) {
          next = {
            ...next,
            matches: value.matches.map((match) => ({
              from: tr.mapping.map(match.from, -1),
              to: tr.mapping.map(match.to, 1),
            })),
            decorations: value.decorations.map(tr.mapping, tr.doc),
            anchor: tr.mapping.map(value.anchor),
            scanPending: true,
          };
        }
        if (tr.docChanged && value.quietSelection) {
          next = { ...next, quietSelection: null };
        }
        const action = tr.getMeta(findPluginKey) as FindAction | undefined;
        if (!action) return next;
        switch (action.type) {
          case 'open':
            return {
              ...next,
              open: true,
              quietSelection: null,
              query: action.query,
              anchor: action.anchor,
              origin: value.open ? value.origin : action.origin,
            };
          case 'close':
            return {
              ...next,
              open: false,
              matches: [],
              currentIndex: -1,
              decorations: DecorationSet.empty,
              origin: null,
              scanPending: false,
              pendingSelect: false,
              quietSelection: action.quiet,
            };
          case 'setQuery':
            return { ...next, query: action.query, scanPending: true, pendingSelect: true };
          case 'results':
            return {
              ...next,
              matches: action.matches,
              currentIndex: action.currentIndex,
              anchor: action.anchor,
              decorations: buildFindDecorations(tr.doc, action.matches, action.currentIndex),
              scanPending: false,
              pendingSelect: false,
            };
          case 'inset':
            return { ...next, overlayInset: action.px };
        }
      },
    },
    props: {
      decorations: (state) => getFindState(state).decorations,
    },
    view: (view) => new FindLifecycle(view, options),
  });
}

/**
 * The rescan scheduler and the notifier.
 *
 * A ProseMirror plugin view cannot dispatch inside its own `update`, so the
 * rescan rides one animation frame behind whatever asked for it.
 */
class FindLifecycle {
  private frame = 0;
  private reportKey: string | null = null;
  private notifiedKey: string | null = null;

  constructor(
    private readonly view: ProseView,
    private readonly options: FindPluginOptions,
  ) {
    this.update();
  }

  update(): void {
    const find = getFindState(this.view.state);
    if (find.open && find.scanPending) this.schedule();
    else if (!find.open) this.reportKey = null;
    else this.report(find);
    this.notify(find);
  }

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.view.dom.isConnected) return;
      const find = getFindState(this.view.state);
      if (!find.open || !find.scanPending) return;
      scanFindResults(this.view, find.pendingSelect);
    });
  }

  private report(find: FindPluginState): void {
    if (!this.options.onMatches) return;
    const report = createFindMatchReport(find.query, find.currentIndex, find.matches.length);
    const key = [report.query, report.current, report.total, report.label].join('\u0000');
    if (key === this.reportKey) return;
    this.reportKey = key;
    this.options.onMatches(report);
  }

  private notify(find: FindPluginState): void {
    if (!this.options.onStateChange) return;
    const key = [
      find.open,
      find.query,
      find.currentIndex,
      find.matches.length,
      find.scanPending,
    ].join('\u0000');
    if (key === this.notifiedKey) return;
    this.notifiedKey = key;
    this.options.onStateChange(find);
  }
}

/** The scroll container the editor lives in: the first scrollable ancestor. */
export function findScroller(view: ProseView): Element | null {
  const window = view.dom.ownerDocument.defaultView;
  let element: Element | null = view.dom;
  while (element) {
    const overflowY = window?.getComputedStyle(element).overflowY ?? '';
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return element;
    element = element.parentElement;
  }
  return view.dom.ownerDocument.scrollingElement;
}

/**
 * Find's own transactions are never undoable: they change selection and plugin
 * state, and a Ctrl-Z after a find step must undo the user's last EDIT.
 */
function findTr(view: ProseView): Transaction {
  const tr = view.state.tr;
  tr.setMeta('addToHistory', false);
  return tr;
}

function dispatchFind(view: ProseView, action: FindAction): void {
  view.dispatch(findTr(view).setMeta(findPluginKey, action));
}

function selectMatch(view: ProseView, match: FindMatch): void {
  const tr = findTr(view);
  const size = tr.doc.content.size;
  if (match.to > size) return;
  tr.setSelection(TextSelection.create(tr.doc, match.from, match.to));
  tr.scrollIntoView();
  view.dispatch(tr);
  revealMatch(view, match);
}

/**
 * Nudge the current match clear of whatever covers the bottom of the viewport.
 *
 * ProseMirror's own `scrollIntoView` knows nothing about the find bar, and
 * `scrollMargin` is a fixed editor prop rather than one a plugin can vary with
 * its state — so the correction is made here, after the scroll it corrects.
 * One frame later, deliberately: the reveal is measured against the layout the
 * selection produced, which is also what makes it right when a reflow moves the
 * match after the initial scroll (docs/spec/editor.md `checkFindReveal`).
 *
 * Desktop measures its own docked panel and reports it through
 * `setFindOverlayInset`; iOS declares its bar's height the same way; Android's
 * bar is a layout sibling above the WebView, so nothing is covered and the
 * inset stays 0.
 */
function revealMatch(view: ProseView, match: FindMatch): void {
  requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    const scroller = findScroller(view);
    if (!scroller) return;
    let coords: { top: number; bottom: number };
    try {
      coords = view.coordsAtPos(Math.min(match.from, view.state.doc.content.size));
    } catch {
      return; // Position not measurable right now (mid-relayout); leave it be.
    }
    const viewport = viewportRect(view, scroller);
    const inset = getFindState(view.state).overlayInset;
    const floor = viewport.bottom - inset - REVEAL_PADDING_PX;
    const ceiling = viewport.top + REVEAL_PADDING_PX;
    if (coords.bottom > floor) scroller.scrollTop += coords.bottom - floor;
    else if (coords.top < ceiling) scroller.scrollTop -= ceiling - coords.top;
  });
}

/** The visible band of `scroller`, in client coordinates. */
function viewportRect(view: ProseView, scroller: Element): { top: number; bottom: number } {
  const document = view.dom.ownerDocument;
  if (scroller === document.scrollingElement || scroller === document.documentElement) {
    return { top: 0, bottom: document.defaultView?.innerHeight ?? scroller.clientHeight };
  }
  const rect = scroller.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom };
}

/**
 * Rescan the document and publish the result.
 *
 * `selectMatch` moves the selection onto the current match; a rescan caused by
 * an EDIT passes false, so the caret stays where the user is typing.
 */
export function scanFindResults(view: ProseView, shouldSelect: boolean): void {
  const find = getFindState(view.state);
  if (!find.open) return;
  const matches = findDocMatches(view.state.doc, find.query);
  const currentIndex = findCurrentMatchIndex(matches, { from: find.anchor, to: find.anchor });
  const current = matches[currentIndex];
  dispatchFind(view, {
    type: 'results',
    matches,
    currentIndex,
    anchor: current?.from ?? find.anchor,
  });
  if (shouldSelect && current) selectMatch(view, current);
}

/**
 * Open find, seeded from the editor's selection when there is one and from the
 * previous query otherwise, and jump to the nearest match.
 */
export function openFind(view: ProseView): boolean {
  const find = getFindState(view.state);
  const selection = view.state.selection;
  const selected = selection.empty
    ? ''
    : view.state.doc.textBetween(selection.from, selection.to, ' ', ' ');
  const query = selected || find.query;
  const matches = findDocMatches(view.state.doc, query);
  const currentIndex = findCurrentMatchIndex(matches, { from: selection.from, to: selection.to });
  const scroller = findScroller(view);
  dispatchFind(view, {
    type: 'open',
    query,
    anchor: selection.from,
    origin: {
      anchor: selection.anchor,
      head: selection.head,
      scroller,
      scrollTop: scroller?.scrollTop ?? 0,
    },
  });
  dispatchFind(view, {
    type: 'results',
    matches,
    currentIndex,
    anchor: matches[currentIndex]?.from ?? selection.from,
  });
  const current = matches[currentIndex];
  if (current) selectMatch(view, current);
  return true;
}

/**
 * Close find.
 *
 * `restoreOrigin` puts the selection and the scroll position back where the
 * user was before find opened — what the native shells' close does
 * (docs/spec/editor.md). Desktop's Escape leaves the selection on the current
 * match instead, and only returns focus.
 */
export function closeFind(
  view: ProseView,
  { returnFocus = false, restoreOrigin = false } = {},
): boolean {
  const find = getFindState(view.state);
  if (!find.open) return false;
  const origin = find.origin;
  const selection = view.state.selection;
  dispatchFind(view, {
    type: 'close',
    quiet: restoreOrigin ? null : { from: selection.from, to: selection.to },
  });
  if (restoreOrigin && origin) {
    const tr = findTr(view);
    const size = tr.doc.content.size;
    tr.setSelection(
      TextSelection.create(tr.doc, Math.min(origin.anchor, size), Math.min(origin.head, size)),
    );
    view.dispatch(tr);
    if (origin.scroller) origin.scroller.scrollTop = origin.scrollTop;
  }
  if (returnFocus) view.focus();
  return true;
}

/** Replace the query. The rescan that follows selects its nearest match. */
export function setFindQuery(view: ProseView, query: string): boolean {
  if (!getFindState(view.state).open) return false;
  dispatchFind(view, { type: 'setQuery', query });
  return true;
}

/** Declare how much of the bottom of the viewport a find bar covers. */
export function setFindOverlayInset(view: ProseView, px: number): void {
  if (getFindState(view.state).overlayInset === px) return;
  dispatchFind(view, { type: 'inset', px });
}

/**
 * Step to the next (`1`) or previous (`-1`) occurrence, wrapping at either end.
 *
 * Rescans first: the document may have changed since the last scan landed, and
 * stepping onto a stale position would select the wrong text.
 */
export function stepFind(view: ProseView, direction: 1 | -1): boolean {
  const find = getFindState(view.state);
  if (!find.open || !find.query) return false;
  const matches = findDocMatches(view.state.doc, find.query);
  if (matches.length === 0) {
    dispatchFind(view, { type: 'results', matches, currentIndex: -1, anchor: find.anchor });
    return false;
  }
  const selection = view.state.selection;
  const selectedIndex = matches.findIndex(
    (match) => match.from === selection.from && match.to === selection.to,
  );
  const nearest = findCurrentMatchIndex(matches, { from: selection.from, to: selection.to });
  const currentIndex = wrapFindMatchIndex(
    selectedIndex >= 0 ? selectedIndex + direction : nearest + (direction === -1 ? -1 : 0),
    matches.length,
  );
  const current = matches[currentIndex];
  dispatchFind(view, { type: 'results', matches, currentIndex, anchor: current.from });
  selectMatch(view, current);
  return true;
}
