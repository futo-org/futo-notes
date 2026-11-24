/* The editor's one selection, the engine's: every native selection change goes to the engine,
 * and its answer comes back to the page when it differs. The native selection stays (its
 * highlight and caret are transparent, the editor draws its own), so IME, VoiceOver and zoom
 * follow it. At a soft wrap one offset is both the upper row's end and the lower row's start:
 * the selection keeps which of the two the caret was put on (`select`), as the page's cannot.
 * A code block can be selected as one object (portable-core/fenced-code.md): the engine says
 * so on every answer (`selected_block`), and ends it on any other selection or edit. Every
 * selection the page hands it is one the user placed (`place_selection`), so a press on a
 * selected empty block's one line, the block's own range, ends it too; the page's echoes of
 * the engine's selection are never handed back. A selection the user makes is fitted to the
 * code blocks around it (codeBlockSelection.ts `fitSelectionToCodeBlocks`), and the engine
 * answers with it fitted out of images; one the engine makes (Undo) is shown as it is. The engine also says when the caret writes a block's language
 * (`writes_language`), which the block's language field then takes (codeBlockHeader.ts). A
 * focused header field holds the native selection: it is not the editor's. */
import type { Affinity, DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { Engine } from './engine';
import { isInCodeHeader } from './codeBlockChrome';
import { fitSelectionToCodeBlocks, type SelectionEnds } from './codeBlockSelection';
import type { CaretArrival } from './formats';
import type { EditorView } from './view';
import { fitSelectionToWikilinks } from './wikilinkUnit';

function spanOf({ anchor, focus }: SelectionEnds): DisplayRange {
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

/** What the engine answered an input with, in display bytes. */
export interface EngineAnswer {
  selection: DisplayRange;
  affinity: Affinity;
  block: DisplayRange | null;
  writesLanguage: boolean;
  writesDelimiterRow: boolean;
}

export class EditorSelection {
  /** The engine's selection in display bytes: shown when the editor takes focus, and so an
   *  echo of it is not sent back as a move. */
  private engineRange: DisplayRange = { start: 0, end: 0 };
  /** Its affinity, as the engine last answered it (caretSide.ts). */
  private engineAffinity: Affinity = 'Forward';
  /** The selection's focus is at the end of the row above the one its offset draws on: a
   *  soft wrap's two rows meet at one offset. Set only by `select`; any other change to the
   *  selection clears it. */
  private focusAtRowEnd = false;
  /** The code block the engine has selected as one object, in display bytes. */
  private engineBlock: DisplayRange | null = null;
  /** The caret stands at a code block's hidden opening fence end: letters write its language. */
  private engineWritesLanguage = false;
  /** The caret is writing a table's delimiter row, which is drawn only then (editorTables.ts). */
  private engineWritesDelimiterRow = false;

  constructor(private readonly view: EditorView) {}

  /** Take a newly opened note's engine's selection. */
  reset(engine: Engine | null): void {
    this.engineRange = engine?.selection() ?? { start: 0, end: 0 };
    this.engineAffinity = 'Forward';
    this.focusAtRowEnd = false;
    this.engineBlock = engine?.selectedBlock() ?? null;
    this.engineWritesLanguage = engine?.writesLanguage() ?? false;
    this.engineWritesDelimiterRow = engine?.writesDelimiterRow() ?? false;
  }

  /** Whether the engine's answer to an input moved the selection, the caret's side or the
   *  selected block: an empty block's selection is a caret that selecting it leaves where it
   *  was. */
  differs(answer: EngineAnswer): boolean {
    const known = this.engineRange;
    return (
      answer.selection.start !== known.start ||
      answer.selection.end !== known.end ||
      answer.affinity !== this.engineAffinity ||
      answer.block?.start !== this.engineBlock?.start ||
      answer.block?.end !== this.engineBlock?.end ||
      answer.writesLanguage !== this.engineWritesLanguage ||
      answer.writesDelimiterRow !== this.engineWritesDelimiterRow
    );
  }

  /** Keep the engine's answer to an input, and show it while the editor has focus. */
  accept(answer: EngineAnswer): void {
    const { selection, affinity, block, writesLanguage } = answer;
    this.engineRange = selection;
    this.engineAffinity = affinity;
    this.engineBlock = block;
    this.engineWritesLanguage = writesLanguage;
    this.engineWritesDelimiterRow = answer.writesDelimiterRow;
    this.focusAtRowEnd = false;
    this.view.typedWikilink.follow();
    if (document.activeElement === this.view.dom) this.showEngineSelection();
  }

  /** The engine's selection as a UTF-16 display range (start ≤ end); null with no note
   *  open. */
  range(): DisplayRange | null {
    const model = this.view.lineModel();
    if (!model) return null;
    const { start, end } = this.engineRange;
    return { start: model.toUtf16(start), end: model.toUtf16(end) };
  }

  /** The code block selected as one object, a UTF-16 display range; null when none is. */
  selectedBlock(): DisplayRange | null {
    const model = this.view.lineModel();
    const block = this.engineBlock;
    if (!model || !block) return null;
    return { start: model.toUtf16(block.start), end: model.toUtf16(block.end) };
  }

  /** Select the code block whose code shows at UTF-16 `at` as one object. */
  selectCodeBlock(at: number): void {
    const engine = this.view.currentEngine();
    const model = this.view.lineModel();
    if (!engine || !model) return;
    this.view.overlays.moved();
    try {
      const change = engine.selectCodeBlock(model.toByte(at));
      this.accept({
        selection: change.selection,
        affinity: change.affinity,
        block: change.selected_block,
        writesLanguage: change.writes_language,
        writesDelimiterRow: change.writes_delimiter_row,
      });
    } catch (error) {
      console.warn('selection refused:', error);
    }
    this.view.overlays.caret.restartBlink();
  }

  /** Whether letters typed now write a code block's language (the caret at its opening fence's
   *  hidden end, as after the third backtick that made it). */
  writesLanguage(): boolean {
    return this.engineWritesLanguage;
  }

  /** Whether the caret is writing a table's delimiter row (the engine's `writes_delimiter_row`). */
  writesDelimiterRow(): boolean {
    return this.engineWritesDelimiterRow;
  }

  /** End a text selection or a selected block at the selection's start, a caret the user
   *  placed: a code block's header field takes focus from the note's selection. */
  collapseToStart(): void {
    const engine = this.view.currentEngine();
    const range = this.range();
    if (!engine || !range || (!this.selectsText() && !this.engineBlock)) return;
    this.view.overlays.moved();
    try {
      const at = this.engineRange.start;
      const affinity = this.view.caretSide.affinity(range.start, range.start, range, {
        kind: 'landed',
      });
      const change = engine.placeSelection({ start: at, end: at }, affinity);
      this.accept({
        selection: change.selection,
        affinity: change.affinity,
        block: change.selected_block,
        writesLanguage: change.writes_language,
        writesDelimiterRow: change.writes_delimiter_row,
      });
    } catch (error) {
      console.warn('selection refused:', error);
    }
  }

  /** The engine's selection in display bytes. */
  bytes(): DisplayRange {
    return this.engineRange;
  }

  /** Whether the engine's selection is not a caret. */
  selectsText(): boolean {
    return this.engineRange.start !== this.engineRange.end;
  }

  affinity(): Affinity {
    return this.engineAffinity;
  }

  /** Whether the selection's focus is at the end of the row above its offset's (see `select`). */
  rowEnd(): boolean {
    return this.focusAtRowEnd;
  }

  /** The native selection's anchor and focus as UTF-16 display offsets: null when it is not
   *  in the editor (a selection can stay anchored in the emptied editor of a closed note). */
  ends(): SelectionEnds | null {
    const view = this.view;
    const selection = document.getSelection();
    const anchor = selection?.anchorNode;
    if (!view.lineModel() || !anchor || !view.dom.contains(anchor) || isInCodeHeader(anchor)) {
      return null;
    }
    return {
      anchor: view.offsetOf(selection.anchorNode, selection.anchorOffset),
      focus: view.offsetOf(selection.focusNode!, selection.focusOffset),
    };
  }

  /** Select from `anchor` to `focus` (UTF-16 display offsets), through the engine; `rowEnd`
   *  puts the focus at the end of the row above, where a soft wrap's rows meet, and `arrival`
   *  says how a caret came there (hitTest.ts `Hit`). */
  select(
    anchor: number,
    focus: number,
    { rowEnd = false, arrival }: { rowEnd?: boolean; arrival?: CaretArrival } = {},
  ): void {
    if (!this.view.lineModel()) return;
    this.showSelection(anchor, focus);
    this.sync(arrival);
    // The engine can move the focus (out of hidden markup): a row end is only where it was put.
    this.focusAtRowEnd = rowEnd && this.ends()?.focus === focus;
    this.view.overlays.caret.restartBlink();
  }

  /** Select UTF-16 display offsets `from`..`to`, the engine at once (a background window
   *  can hold `selectionchange` back for a while); false when they are outside the note. */
  selectRange(from: number, to: number): boolean {
    const model = this.view.lineModel();
    if (!model) return false;
    const length = model.length;
    if (from < 0 || to < 0 || from > length || to > length) return false;
    this.focusAtRowEnd = false;
    this.showSelection(from, to);
    this.sync({ kind: 'landed' });
    return true;
  }

  /** Hand a moved native selection to the engine and show its answer: the same range, or
   *  one it adjusted (out of a CRLF, out of hidden markup); a move goes to it fitted to the
   *  code blocks around it. The page can also leave its
   *  selection between line elements (a removed line, a press below the last line), which
   *  is written back inside the text at the same offsets, so the caret, input methods and
   *  the next keystroke all see one place. An echo of the engine's own selection is not a
   *  move: the engine would end the typing run (and its Undo step), but a caret put somewhere
   *  by `arrival` takes the side that names (caretSide.ts `affinity`). Returns the engine's
   *  selection, as `range()`. */
  sync(arrival?: CaretArrival): DisplayRange | null {
    const shown = this.ends();
    const engine = this.view.currentEngine();
    const model = this.view.lineModel();
    if (!shown || !engine || !model) return this.range();
    const known = this.engineRange;
    const moved = this.view.bytes(spanOf(shown));
    if (arrival || moved.start !== known.start || moved.end !== known.end) {
      const fitted = fitSelectionToCodeBlocks(model, shown);
      const ends = fitSelectionToWikilinks(model, fitted, {
        start: model.toUtf16(known.start),
        end: model.toUtf16(known.end),
      });
      const { start, end } = spanOf(ends);
      const range = this.view.bytes({ start, end });
      this.focusAtRowEnd = false;
      this.view.overlays.moved();
      try {
        const affinity = this.view.caretSide.affinity(start, end, this.range()!, arrival);
        const change = engine.placeSelection(range, affinity);
        this.engineRange = change.selection;
        this.engineAffinity = change.affinity;
        this.engineBlock = change.selected_block;
        this.engineWritesLanguage = change.writes_language;
        this.engineWritesDelimiterRow = change.writes_delimiter_row;
      } catch (error) {
        console.warn('selection refused:', error);
      }
      this.view.typedWikilink.follow();
    }
    this.showEngineSelection();
    return this.range();
  }

  /** Show the engine's selection, its direction kept from the page's, or `backward` where the
   *  page's was drawn over. */
  showEngineSelection(backward?: boolean): void {
    const range = this.range();
    if (!range) return;
    const ends = this.ends();
    if (backward ?? (ends !== null && ends.focus < ends.anchor))
      this.showSelection(range.end, range.start);
    else this.showSelection(range.start, range.end);
    this.view.overlays.caret.schedule();
  }

  /** Take the native selection out of the editor, where it is; a header field's stays. */
  clearNativeSelection(): void {
    const selection = document.getSelection();
    const anchor = selection?.anchorNode;
    if (anchor && this.view.dom.contains(anchor) && !isInCodeHeader(anchor)) {
      selection.removeAllRanges();
    }
  }

  /** Put the DOM selection's anchor and focus on these offsets, always at a point inside
   *  the line's text: a line removed under the caret leaves the browser's selection on an
   *  element boundary at the same offset, where the caret cannot be measured. */
  private showSelection(anchor: number, focus: number): void {
    const selection = document.getSelection();
    if (!selection || !this.view.lineModel()) return;
    const [anchorNode, anchorOffset] = this.view.caretSide.place(anchor).point;
    const [focusNode, focusOffset] = this.view.caretSide.place(focus).point;
    const placed =
      selection.anchorNode === anchorNode &&
      selection.anchorOffset === anchorOffset &&
      selection.focusNode === focusNode &&
      selection.focusOffset === focusOffset;
    if (!placed) selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  }
}
