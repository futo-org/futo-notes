import { EditorSelection, type Extension, type StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin, getPanel, type ViewUpdate } from '@codemirror/view';

import {
  clearMarkdownSelectionReveal,
  createSelectionRevealSnapshot,
  freezeMarkdownSelectionReveal,
  liveMarkdownRefresh,
  markdownSelectionRevealState,
  suppressMarkdownSelectionReveal,
} from '../liveMarkdownTransform';
import { findDecorations } from './findDecorations';
import { createFindMatchReport, type FindMatchReport } from './findMatches';
import { createFindPanel, findPanel } from './findPanel';
import {
  checkFindReveal,
  findScrollMargin,
  findState,
  scanFindResults,
  setFindQueryEffect,
} from './findState';

/**
 * How many times one reveal may re-scroll itself. The reflow a reveal causes
 * needs one; the cap is what keeps a pathological layout from ping-ponging.
 */
const REVEAL_CORRECTION_LIMIT = 2;

class FindLifecycle {
  private scanFrame = 0;
  private scanShouldSelect = false;
  private revealKey: string | null = null;
  private reportKey: string | null = null;
  /** The reveal still waiting to be confirmed clear of the bottom overlay. */
  private pendingReveal: { corrections: number } | null = null;
  private revealCheckScheduled = false;

  constructor(
    private readonly view: EditorView,
    private readonly onMatches?: (report: FindMatchReport) => void,
    private readonly panelDom: (view: EditorView) => HTMLElement | null = () => null,
  ) {
    this.syncReveal();
  }

  update(update: ViewUpdate): void {
    const value = update.state.field(findState);
    const queryChanged = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(setFindQueryEffect)),
    );
    const recomputePending = value.open && (update.docChanged || queryChanged);
    if (recomputePending) {
      // A query change intentionally selects its nearest result. A body edit or
      // external-content adoption must only refresh matches: moving selection
      // here would redirect the user's next keystroke into a match.
      this.scheduleScan(queryChanged);
    }
    if (!value.open) this.reportKey = null;
    else if (!recomputePending) this.reportMatches();
    this.syncReveal();
    // Every update after a reveal is a chance for the relayout that moved the
    // match back under the bar to have landed.
    this.scheduleRevealCheck();
  }

  destroy(): void {
    if (this.scanFrame) cancelAnimationFrame(this.scanFrame);
    this.scanFrame = 0;
    this.pendingReveal = null;
    // Reveal state is per-editor now, so it dies with a destroyed view; this
    // only matters when the extension is reconfigured out from under a live one.
    this.revealKey = null;
    this.dispatchReveal(this.clearRevealEffects());
  }

  private scheduleScan(selectMatch: boolean): void {
    this.scanShouldSelect ||= selectMatch;
    if (this.scanFrame) cancelAnimationFrame(this.scanFrame);
    this.scanFrame = requestAnimationFrame(() => {
      this.scanFrame = 0;
      const shouldSelect = this.scanShouldSelect;
      this.scanShouldSelect = false;
      scanFindResults(this.view, shouldSelect);
    });
  }

  private syncReveal(): void {
    const value = this.view.state.field(findState);
    const current = value.open ? value.matches[value.currentIndex] : undefined;
    const nextKey = current ? `${current.from}:${current.to}` : '';
    if (nextKey === this.revealKey) return;
    this.revealKey = nextKey;
    this.pendingReveal = current ? { corrections: 0 } : null;
    // Find owns its own reveal layer, so a pointer gesture settling cannot
    // clear the freeze holding the current match's markdown syntax open.
    this.dispatchReveal(
      current
        ? [
            freezeMarkdownSelectionReveal.of({
              owner: 'find',
              snapshot: createSelectionRevealSnapshot(true, [current]),
            }),
            suppressMarkdownSelectionReveal.of({ owner: 'find', suppressed: true }),
          ]
        : this.clearRevealEffects(),
    );
  }

  private clearRevealEffects(): StateEffect<unknown>[] {
    return [
      clearMarkdownSelectionReveal.of('find'),
      suppressMarkdownSelectionReveal.of({ owner: 'find', suppressed: false }),
    ];
  }

  // A ViewPlugin cannot dispatch inside its own update cycle, so the reveal
  // change rides one microtask behind alongside the decoration refresh.
  private dispatchReveal(effects: StateEffect<unknown>[]): void {
    queueMicrotask(() => {
      if (!this.view.dom.isConnected) return;
      this.view.dispatch({ effects: [...effects, liveMarkdownRefresh.of(null)] });
    });
  }

  /**
   * Re-read the current match once the DOM has been laid out again, and
   * re-reveal it when the relayout left it under the overlay (see
   * {@link checkFindReveal}). Reading layout is only legal in a measure pass,
   * and dispatching is only legal outside one — hence the measure request and
   * the deferred dispatch.
   */
  private scheduleRevealCheck(): void {
    if (!this.pendingReveal || this.revealCheckScheduled) return;
    this.revealCheckScheduled = true;
    this.view.requestMeasure({
      read: (view) => checkFindReveal(view, this.panelDom(view)),
      write: (result, view) => {
        this.revealCheckScheduled = false;
        const pending = this.pendingReveal;
        if (!pending || !result) return;
        if (!result.clipped || pending.corrections >= REVEAL_CORRECTION_LIMIT) {
          this.pendingReveal = null;
          return;
        }
        pending.corrections += 1;
        const { from, to } = result.match;
        queueMicrotask(() => {
          // Deferred, so re-check the bar is still open: closing find can
          // restore the pre-find scroll position, and a stale correction
          // would scroll straight back off it.
          if (!view.dom.isConnected || !view.state.field(findState).open) return;
          view.dispatch({ effects: EditorView.scrollIntoView(EditorSelection.range(from, to)) });
        });
      },
    });
  }

  private reportMatches(): void {
    if (!this.onMatches) return;
    const value = this.view.state.field(findState);
    const report = createFindMatchReport(value.query, value.currentIndex, value.matches.length);
    const nextKey = `${report.query}:${report.current}:${report.total}:${report.label}`;
    if (nextKey === this.reportKey) return;
    this.reportKey = nextKey;
    this.onMatches(report);
  }
}

interface FindExtensionOptions {
  nativeShell?: boolean;
  onQueryFocus?: () => void;
  onMatches?: (report: FindMatchReport) => void;
}

export function findExtension(options: FindExtensionOptions = {}): Extension {
  const panel = options.nativeShell ? null : createFindPanel(options.onQueryFocus);
  const panelDom = (view: EditorView): HTMLElement | null =>
    panel ? (getPanel(view, panel)?.dom ?? null) : null;
  const lifecycle = ViewPlugin.define(
    (view) => new FindLifecycle(view, options.onMatches, panelDom),
  );
  return [
    markdownSelectionRevealState,
    findState,
    ...(panel ? [findPanel(panel)] : []),
    // Whatever covers the editor's bottom strip has to stay out of the reveal
    // area, or the current match hides under the bar the user is stepping
    // with. The native bars declare their height over the bridge; desktop's
    // panel is docked over the pane's own scrollport, so the engine measures
    // that one itself instead of asking the shell to report it.
    EditorView.scrollMargins.of((view) => findScrollMargin(view, panelDom(view))),
    findDecorations,
    lifecycle,
  ];
}
