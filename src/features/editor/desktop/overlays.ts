/* What the editor draws over its text, all on the caret's frame (caret.ts `schedule`), so a
 * keystroke reads layout once: the caret and its flag, the selection's highlight, and where
 * the selection toolbar goes and what it shows (FormatToolbar.svelte draws it). */
import { blockButtons, type BlockButton } from './blockButtons';
import { Caret, measureCaret, paneOf, revealCaret, type CaretBox } from './caret';
import { desktopEditorDebug } from './debugToggles.svelte';
import { formatButtons, type FormatButton } from './formats';
import { Highlight, selectedBands, type Band } from './highlight';
import { isWithinCode } from './codeBlockSelection';
import { markSelectedPictures } from './pictureSelection';
import { visibleCaret } from './tableScroll';
import type { KeystrokeTimings } from './timings';
import type { EditorView } from './view';

/** The selection toolbar's buttons and where the selection is, relative to the editor's
 *  wrapper: the selected rows' extent, the pane's visible top and bottom, and the wrapper's
 *  width. */
export interface ToolbarState {
  blocks: BlockButton[];
  buttons: FormatButton[];
  /** The selection lies in one link: the Link button is lit (linkPrompt.ts `lit`). */
  link: boolean;
  /** The engine says a link would change nothing there (`allowed` leaves Link out). */
  linkDisabled: boolean;
  left: number;
  right: number;
  top: number;
  bottom: number;
  paneTop: number;
  paneBottom: number;
  width: number;
}

/** How long typing pauses before a flag hidden while typing shows again. */
const TYPING_PAUSE_MS = 1000;

export class EditorOverlays {
  readonly caret: Caret;
  private readonly highlight: Highlight;
  /** The toolbar state last handed out, as JSON: a frame that changes nothing hands none. */
  private shownToolbar = 'null';
  /** An edit hid the flag (the "hide while typing" toggle) until the caret moves or typing
   *  pauses. */
  private typing = false;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  /** The image elements the selection's tint is on (pictureSelection.ts). */
  private selectedPictures: HTMLElement[] = [];

  constructor(
    private readonly view: EditorView,
    private readonly wrap: HTMLElement,
    timings: KeystrokeTimings,
    private readonly showToolbar: (state: ToolbarState | null) => void,
  ) {
    this.highlight = new Highlight(wrap);
    this.caret = new Caret(
      wrap,
      () => this.caretRect(),
      timings,
      () => this.paint(),
      (box) => this.revealFocus(box),
      () => (desktopEditorDebug.showCaretFlag ? this.flag() : []),
    );
  }

  destroy(): void {
    clearTimeout(this.typingTimer);
    this.caret.destroy();
  }

  /** The marks the caret's flag shows when it is drawn (formatting.ts `flag`, debugToggles
   *  `showCaretFlag`), none while typing hides it. */
  flag(): string[] {
    return this.typing ? [] : this.view.formatting.flag();
  }

  /** An edit was shown: with the toggle on, the flag hides until the caret moves or typing
   *  pauses. */
  edited(): void {
    if (!desktopEditorDebug.hideFlagWhileTyping) return;
    this.typing = true;
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.moved(), TYPING_PAUSE_MS);
  }

  /** The caret moved without an edit, or typing paused: a hidden flag shows again. */
  moved(): void {
    if (!this.typing) return;
    this.typing = false;
    clearTimeout(this.typingTimer);
    this.caret.schedule();
  }

  /** Where the caret goes, relative to the editor's wrapper: null without a collapsed
   *  selection in the editor, or on a code block selected as one object (an empty one's
   *  selection is a caret). It is drawn only while the window has focus too. */
  caretRect(): CaretBox | null {
    const view = this.view;
    const range = view.selection.range();
    const model = view.lineModel();
    const selection = document.getSelection();
    if (document.activeElement !== view.dom || !range || !model || range.start !== range.end) {
      return null;
    }
    if (view.selection.selectedBlock()) return null;
    if (!view.selection.ends()) return null;
    const line = view.lineElements()[model.lineAt(range.start)];
    // While composing, the marked text is in the DOM but not the model: follow the browser.
    if (view.isComposing() && selection?.focusNode) {
      return measureCaret(selection.focusNode, selection.focusOffset, line, this.wrap);
    }
    const rowEnd = view.selection.rowEnd();
    const { point, edge } = view.caretSide.place(range.start, rowEnd);
    const box = measureCaret(...point, line, this.wrap, rowEnd);
    if (edge !== null) box.left = edge - this.wrap.getBoundingClientRect().left;
    return visibleCaret(line, box, this.wrap);
  }

  /** After an edit, bring the caret's row into the pane (`caret` is its box, measured for the
   *  draw), or with a selection its focus's row. */
  private revealFocus(caret: CaretBox | null): void {
    const view = this.view;
    if (!caret) {
      const focus = view.selection.ends()?.focus;
      const model = view.lineModel();
      if (focus === undefined || !model) return;
      const line = view.lineElements()[model.lineAt(focus)];
      caret = measureCaret(...view.pointAt(focus), line, this.wrap);
    }
    revealCaret(caret, this.wrap, view.dom);
  }

  /** The highlight follows the engine's selection while the editor has focus, as the native
   *  one did; so does the toolbar, but not while a press drags or an input method composes,
   *  nor over code (a block selected as one object, or a selection only in code lines). The
   *  header of the block the caret is in is drawn active. */
  private paint(): void {
    const view = this.view;
    view.tables.paint();
    view.codeHeader.markActive();
    view.find.paint();
    view.completion.update();
    view.slashMenu.update();
    const range = view.selection.range();
    const model = view.lineModel();
    const shown = range && model && document.activeElement === view.dom && view.selection.ends();
    const block = view.selection.selectedBlock();
    const bands = shown ? selectedBands(view.lineElements(), model, range, this.wrap, block) : [];
    this.highlight.draw(bands);
    if (model) {
      const selected = shown && !block ? range : null;
      this.selectedPictures = markSelectedPictures(
        view.lineElements(),
        model,
        selected,
        this.selectedPictures,
      );
    }
    const toolbar =
      shown &&
      bands.length > 0 &&
      !block &&
      !view.find.suppressesToolbar() &&
      !isWithinCode(model, range) &&
      !view.isComposing() &&
      !view.pointer.dragging()
        ? this.toolbar(bands)
        : null;
    const json = JSON.stringify(toolbar);
    if (json === this.shownToolbar) return;
    this.shownToolbar = json;
    this.showToolbar(toolbar);
  }

  /** The toolbar for a selection drawn as `bands`; null when it selects only whitespace. */
  private toolbar(bands: readonly Band[]): ToolbarState | null {
    const selected = this.view.formatting.formats();
    if (!selected?.text) return null;
    const base = this.wrap.getBoundingClientRect();
    const pane = paneOf(this.view.dom).getBoundingClientRect();
    return {
      blocks: blockButtons(selected.blocks),
      buttons: formatButtons(selected),
      link: this.view.linkPrompt.lit(),
      linkDisabled: !selected.allowed.includes('Link'),
      left: Math.round(Math.min(...bands.map((band) => band.left))),
      right: Math.round(Math.max(...bands.map((band) => band.left + band.width))),
      top: Math.round(Math.min(...bands.map((band) => band.top))),
      bottom: Math.round(Math.max(...bands.map((band) => band.top + band.height))),
      paneTop: Math.round(pane.top - base.top),
      paneBottom: Math.round(pane.bottom - base.top),
      width: Math.round(base.width),
    };
  }
}
