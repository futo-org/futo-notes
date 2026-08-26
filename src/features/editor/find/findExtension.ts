import type { Extension, StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

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
import { findPanel } from './findPanel';
import { findScrollMargin, findState, scanFindResults, setFindQueryEffect } from './findState';

class FindLifecycle {
  private scanFrame = 0;
  private scanShouldSelect = false;
  private revealKey: string | null = null;
  private reportKey: string | null = null;

  constructor(
    private readonly view: import('@codemirror/view').EditorView,
    private readonly onMatches?: (report: FindMatchReport) => void,
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
  }

  destroy(): void {
    if (this.scanFrame) cancelAnimationFrame(this.scanFrame);
    this.scanFrame = 0;
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
  const lifecycle = ViewPlugin.define((view) => new FindLifecycle(view, options.onMatches));
  return [
    markdownSelectionRevealState,
    findState,
    ...(options.nativeShell ? [] : [findPanel(options.onQueryFocus)]),
    // Host chrome (the native find bars) can cover the editor's bottom strip;
    // every find reveal has to clear it, or the current match hides under the
    // bar the user is stepping with. Desktop's find panel is a CM6 panel and
    // shrinks the scroller itself, so it reports no overlay.
    EditorView.scrollMargins.of((view) => findScrollMargin(view.state)),
    findDecorations,
    lifecycle,
  ];
}
