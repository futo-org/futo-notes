/* Find in the note (docs/spec/editor/desktop/find.md) over the engine's find
 * (portable-core/find.md): the page opens it, hands it the query and the steps, draws what it
 * reports and scrolls to its current match. The bar is the shell's (FindPanel.svelte); it hears
 * of every change through `ViewHost.findBar`. The engine never scans on the input path: an edit
 * only schedules one rescan for when typing settles, and in between the matches it carries
 * through the edits are what is drawn. */
import type { DisplayRange, FindReport } from '@futo-notes/editor/wasm-payloads';
import type { FindBarState } from '$features/editor/milkdown/find';
import { localizedText } from '$shared/localization';
import type { Engine } from './engine';
import { findBands, findWindowRange, FindLayer, matchRects } from './findBands';
import { paneOf } from './caret';
import { reveal } from './paneScroll';
import type { EditorView } from './view';

/** How long input pauses before the note is scanned again (the Android host's
 *  FIND_REFRESH_MS). */
const RESCAN_IDLE_MS = 150;

/** How long a query waits for the frame it is scanned on before it is scanned anyway: a window
 *  in the background draws no frames (the Milkdown find's FIND_RESCAN_FALLBACK_MS). */
const QUERY_FALLBACK_MS = 200;

/** Room kept above and below a revealed match, besides the bar over the pane's bottom. */
const REVEAL_PADDING_PX = 8;

const CLOSED: FindBarState = {
  open: false,
  query: '',
  label: '',
  hasMatches: false,
  focusToken: 0,
};

export class EditorFind {
  private readonly layer: FindLayer;
  private bar: FindBarState = CLOSED;
  private report: FindReport | null = null;
  /** The engine find was opened on; a note switch replaces it. */
  private engine: Engine | null = null;
  /** A press has selected the current match since the query last changed (the engine's
   *  host plan, host/find_plan.rs `FindLanding`): the next press steps from it. */
  private landed = false;
  private barHeight = 0;
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;
  private queryFrame = 0;
  private queryTimer: ReturnType<typeof setTimeout> | undefined;
  /** A query typed and not yet scanned; null when none waits. */
  private pendingQuery: string | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly wrap: HTMLElement,
    private readonly showBar: (state: FindBarState) => void,
  ) {
    this.layer = new FindLayer(wrap);
  }

  isOpen(): boolean {
    return this.bar.open;
  }

  /** What Puppet reads: the same fields the other editors report, `query` the one last
   *  scanned (the count's). */
  puppetState(): { open: boolean; query: string; current: number; total: number } {
    const report = this.report;
    return {
      open: this.bar.open,
      query: report?.query ?? '',
      current: report?.current ?? 0,
      total: report?.total ?? 0,
    };
  }

  /** Ctrl/Cmd+F: open with the selection's text when it lies within one line, else the query
   *  find last had in this note; with the bar open, focus and select its query again. */
  open(): void {
    const engine = this.view.currentEngine();
    if (!engine) return;
    if (this.bar.open) {
      this.emit({ focusToken: this.bar.focusToken + 1 });
      return;
    }
    this.engine = engine;
    const query = this.selectedText() ?? engine.find().report().query;
    this.runQuery(query, this.bar.focusToken + 1);
  }

  /** The query field changed: one scan a frame, as fast as it is typed. */
  setQuery(query: string): void {
    if (!this.bar.open) return;
    const waiting = this.pendingQuery !== null;
    this.pendingQuery = query;
    this.bar = { ...this.bar, query };
    if (waiting) return;
    const run = (): void => this.flushQuery();
    this.queryFrame = requestAnimationFrame(run);
    this.queryTimer = setTimeout(run, QUERY_FALLBACK_MS);
  }

  /** Scan a query typed and not yet scanned, now. */
  private flushQuery(): void {
    const query = this.pendingQuery;
    this.cancelQuery();
    if (query !== null && this.bar.open) this.runQuery(query, this.bar.focusToken);
  }

  private cancelQuery(): void {
    cancelAnimationFrame(this.queryFrame);
    clearTimeout(this.queryTimer);
    this.queryFrame = 0;
    this.queryTimer = undefined;
    this.pendingQuery = null;
  }

  /** Enter, Shift+Enter, the bar's arrows, Ctrl/Cmd+G: the first press after a query change
   *  selects the current match, later ones step from it, wrapping. */
  step(direction: 1 | -1): void {
    const engine = this.liveEngine();
    if (!engine || this.view.isComposing()) return;
    this.flushQuery();
    let report = engine.find().report();
    const land = !this.landed && report.current_range !== null;
    this.view.run((current) => {
      if (land) current.placeSelection(report.current_range!, 'Forward');
      else report = current.find().step(direction === 1);
      return null;
    }, false);
    const landing = land ? report.current_range : report.reveal;
    if (landing) this.landed = true;
    this.show(report, landing);
  }

  /** Escape or the bar's ×: the highlights go, the caret is left at the current match's end
   *  and the editor takes focus back. */
  close(): void {
    const engine = this.liveEngine();
    if (!engine) {
      this.reset();
      return;
    }
    this.flushQuery();
    const current = engine.find().report().current_range;
    engine.find().close();
    if (current) {
      this.view.run((live) => {
        live.placeSelection({ start: current.end, end: current.end }, 'Forward');
        return null;
      }, false);
    }
    this.reset();
    this.view.focus();
  }

  /** The bar's height over the bottom of the pane, which a revealed match stays above. */
  setBarHeight(pixels: number): void {
    this.barHeight = pixels;
  }

  /** The view shows another note (or none): find closes without a word to the old engine. */
  noteOpened(): void {
    this.reset();
  }

  /** An edit was shown: the matches follow it, and one rescan runs once input settles. */
  edited(): void {
    if (!this.bar.open) return;
    clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => this.rescan(), RESCAN_IDLE_MS);
  }

  /** Whether the selection toolbar stays down: find is open, and its steps select matches. */
  suppressesToolbar(): boolean {
    return this.bar.open;
  }

  /** Draw the matches on the lines near the screen, on the caret's frame; none while an input
   *  method composes, as its marked text is not yet the engine's. The current match is read
   *  afresh: an edit before it moves it. A refusal draws none, and leaves the rest of the
   *  frame (the caret, the selection) to draw. */
  paint(): void {
    const engine = this.liveEngine();
    const model = this.view.lineModel();
    const elements = this.view.lineElements();
    const lines = model && findWindowRange(elements, model);
    if (!engine || !model || !lines || this.view.isComposing()) {
      this.layer.draw([]);
      return;
    }
    const toUtf16 = (range: DisplayRange): DisplayRange => ({
      start: model.toUtf16(range.start),
      end: model.toUtf16(range.end),
    });
    try {
      const find = engine.find();
      const matches = find.matches(this.view.bytes(lines)).map(toUtf16);
      const currentRange = find.report().current_range;
      const current = currentRange && toUtf16(currentRange);
      this.layer.draw(findBands(elements, model, matches, current, this.wrap));
    } catch (error) {
      console.warn('find matches refused:', error);
      this.layer.draw([]);
    }
  }

  private rescan(): void {
    const engine = this.liveEngine();
    if (!engine) return;
    if (this.view.isComposing()) {
      this.edited();
      return;
    }
    this.show(engine.find().rescan() ?? engine.find().report(), null);
  }

  private runQuery(query: string, focusToken: number): void {
    const engine = this.liveEngine();
    if (!engine) return;
    clearTimeout(this.rescanTimer);
    this.landed = false;
    const report = engine.find().setQuery(query);
    this.bar = { ...this.bar, focusToken };
    this.show(report, report.reveal);
  }

  /** Take `report`, tell the bar, redraw, and bring `revealed` (display bytes) into the pane. */
  private show(report: FindReport, revealed: DisplayRange | null): void {
    this.report = report;
    this.emit({
      open: report.open,
      query: report.query,
      label: localizedText('editor.find.matchCount', {
        current: report.current,
        total: report.total,
      }),
      hasMatches: report.total > 0,
    });
    if (revealed) this.reveal(revealed);
    this.view.redraw();
  }

  private reveal(range: DisplayRange): void {
    const model = this.view.lineModel();
    if (!model) return;
    const utf16 = { start: model.toUtf16(range.start), end: model.toUtf16(range.end) };
    const [rect] = matchRects(this.view.lineElements(), model, utf16);
    if (!rect) return;
    this.view.tables.reveal(model.lineAt(utf16.start), rect.left, rect.right);
    const half = rect.height / 2 + REVEAL_PADDING_PX;
    reveal(rect.top + rect.height / 2, half, paneOf(this.view.dom), this.barHeight);
  }

  /** The engine find is open on, while the view still shows it. */
  private liveEngine(): Engine | null {
    const engine = this.view.currentEngine();
    return engine && engine === this.engine ? engine : null;
  }

  /** The selection's text, when it is text within one line. */
  private selectedText(): string | null {
    const range = this.view.selection.range();
    const model = this.view.lineModel();
    if (!range || !model || range.start === range.end) return null;
    const line = model.lines[model.lineAt(range.start)];
    if (range.end > line.start + line.text.length) return null;
    return line.text.slice(range.start - line.start, range.end - line.start);
  }

  private reset(): void {
    clearTimeout(this.rescanTimer);
    this.cancelQuery();
    this.engine = null;
    this.report = null;
    this.landed = false;
    this.layer.draw([]);
    if (this.bar.open) this.emit({ ...CLOSED, focusToken: this.bar.focusToken });
  }

  private emit(next: Partial<FindBarState>): void {
    this.bar = { ...this.bar, ...next };
    this.showBar(this.bar);
  }
}
