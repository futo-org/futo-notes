/* A fenced code block's header fields (codeBlockChrome.ts draws them): the name on the left and
 * the language on the right, each edited where it is clicked. A field is the editing buffer
 * while it has focus, and the block's header is written once, through the engine, when focus
 * leaves the header (`set_code_block_header`, one Undo step); a value the engine refuses goes
 * back to the block's own. Entering a field ends the note's selection at its start: the note
 * shows no caret and no highlight while a field has focus. Enter and Down put the caret at the start of the
 * block's code, Up at the end of the line above; Tab walks name, language, code and Shift+Tab
 * back; Escape puts back the value the field had and leaves, the name to where the caret was,
 * the language to the code. While the caret writes a block's language (after the third
 * backtick that made it), the language field takes it (`followLanguageCaret`). The copy button
 * copies the block's code (codeBlockCopy.ts). */
import {
  codeHeaderControls,
  codeHeaderOf,
  isCodeHeader,
  isCodeHeaderControl,
  sizeCodeField,
  CODE_LANGUAGE_CLASS,
} from './codeBlockChrome';
import { codeBlockLinesAt } from './codeBlockSelection';
import { codeBlockText, flashCopied } from './codeBlockCopy';
import { isTabKey } from '$shared/dom/tabKey';
import { historyKey } from './keys';
import type { EditorView } from './view';

/** Where the caret goes when a field is left: the block's code start, the line above the
 *  block, or where it was. */
type FieldExit = 'code' | 'above' | 'back';

/** Which header field has focus and what it holds, for Puppet's `state`. */
export interface FocusedCodeField {
  field: 'name' | 'language';
  value: string;
}

export class EditorCodeHeader {
  /** The header being edited: its fields' values are written when focus leaves it. */
  private editing: HTMLElement | null = null;
  /** The value the focused field had when it took focus, for Escape. */
  private focusedValue = '';
  /** The header of the block the caret is in, drawn active (its empty fields shown). */
  private activeHeader: HTMLElement | null = null;

  constructor(
    private readonly view: EditorView,
    /** Puts the text on the clipboard and says so; true when it did. */
    private readonly copyCode: (text: string) => Promise<boolean>,
  ) {}

  /** Listen on the editor for its headers' controls. Returns the listeners' removal. */
  listen(dom: HTMLElement): () => void {
    const listeners: Array<[string, (event: Event) => void]> = [
      ['focusin', (event) => this.focusIn(event as FocusEvent)],
      ['focusout', (event) => this.focusOut(event as FocusEvent)],
      ['keydown', (event) => this.keyDown(event as KeyboardEvent)],
      ['input', (event) => this.input(event)],
      ['compositionend', (event) => this.input(event)],
      ['mousedown', (event) => this.mouseDown(event as MouseEvent)],
      ['click', (event) => this.click(event as MouseEvent)],
    ];
    for (const [type, handler] of listeners) dom.addEventListener(type, handler);
    return () => {
      for (const [type, handler] of listeners) dom.removeEventListener(type, handler);
    };
  }

  /** When the caret writes a code block's language, its language field takes focus, empty and
   *  ready to type, instead of a caret drawn in the code. */
  followLanguageCaret(): void {
    const view = this.view;
    if (!view.selection.writesLanguage() || document.activeElement !== view.dom) return;
    const header = this.headerOfSelection();
    if (header) codeHeaderControls(header).language.focus({ preventScroll: true });
  }

  /** Shift+Tab at the start of a block's first code line, where it has nothing to outdent:
   *  the language field takes focus. False anywhere else. */
  focusLanguageFromCode(): boolean {
    const view = this.view;
    const range = view.selection.range();
    if (!range || range.start !== range.end || view.selection.selectedBlock()) return false;
    const line = view.displayLines()[view.lineAt(range.start)];
    if (!line.code?.first || range.start !== line.start || /^[ \t]/.test(line.text)) return false;
    const header = this.headerOfSelection();
    if (!header) return false;
    codeHeaderControls(header).language.focus({ preventScroll: true });
    return true;
  }

  /** The focused header field, or null. */
  focusedField(): FocusedCodeField | null {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLInputElement) || !isCodeHeaderControl(focused)) return null;
    const field = focused.classList.contains(CODE_LANGUAGE_CLASS) ? 'language' : 'name';
    return { field, value: focused.value };
  }

  /** Draw the header of the block the caret is in (or whose field has focus) as active, on the
   *  caret's frame: its empty fields show their placeholders. */
  markActive(): void {
    const header = codeHeaderOf(document.activeElement) ?? this.headerOfSelection();
    if (header === this.activeHeader) return;
    this.activeHeader?.classList.remove('active');
    header?.classList.add('active');
    this.activeHeader = header;
  }

  /** The header of the code block the editor's selection starts in, while the editor has
   *  focus; null outside code. */
  private headerOfSelection(): HTMLElement | null {
    const view = this.view;
    const range = view.selection.range();
    if (!range || document.activeElement !== view.dom) return null;
    const lines = view.displayLines();
    const index = view.lineAt(range.start);
    if (!lines[index]?.code) return null;
    const first = view.lineElements()[codeBlockLinesAt(lines, index).first];
    return isCodeHeader(first.firstChild) ? first.firstChild : null;
  }

  private focusIn(event: FocusEvent): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !isCodeHeaderControl(input)) return;
    this.focusedValue = input.value;
    const header = codeHeaderOf(input)!;
    if (this.editing === header) return;
    this.editing = header;
    this.view.selection.collapseToStart();
    this.view.redraw();
  }

  /** Focus leaving the header writes it; moving between its two fields does not. */
  private focusOut(event: FocusEvent): void {
    if (!isCodeHeaderControl(event.target)) return;
    const header = this.editing;
    if (!header) return;
    if (event.relatedTarget instanceof Node && codeHeaderOf(event.relatedTarget) === header) return;
    this.writeEditedHeader();
    this.view.redraw();
  }

  /** Write the header being edited, if any: before the note is switched away from or the
   *  editor is torn down, which take the fields without a blur. */
  writeEditedHeader(): void {
    const header = this.editing;
    if (!header) return;
    this.editing = null;
    this.write(header);
  }

  private keyDown(event: KeyboardEvent): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !isCodeHeaderControl(input)) return;
    const header = codeHeaderOf(input)!;
    const history = historyKey(event, navigator.platform.startsWith('Mac'));
    // With nothing typed in the field, Undo and Redo are the note's: an Undo that brought
    // back a language caret gave this field focus, and the next Undo must go on.
    if (history && input.value === this.focusedValue) {
      this.leave(event, header, 'back');
      this.view.run((engine) => (history === 'redo' ? engine.redo() : engine.undo()));
      return;
    }
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const { name, language } = codeHeaderControls(header);
    const isLanguage = input === language;
    switch (isTabKey(event) ? 'Tab' : event.key) {
      case 'Enter':
      case 'ArrowDown':
        return this.leave(event, header, 'code');
      case 'ArrowUp':
        if (this.view.lineAt(this.codeStart(header)) > 0) this.leave(event, header, 'above');
        return;
      case 'Escape':
        input.value = this.focusedValue;
        sizeCodeField(input);
        return this.leave(event, header, isLanguage ? 'code' : 'back');
      case 'Tab':
        if (isLanguage && !event.shiftKey) return this.leave(event, header, 'code');
        event.preventDefault();
        if (isLanguage) name.focus();
        else if (!event.shiftKey) language.focus();
    }
  }

  /** A field keeps of typed or pasted text what the engine says it may hold (no backtick, the
   *  language one word): a value the engine would refuse loses the whole header when the field
   *  is left. Text an input method is still composing (a dead key's accent) is left alone until
   *  it is done. */
  private input(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !isCodeHeaderControl(input)) return;
    const composing = event instanceof InputEvent && event.isComposing;
    const engine = this.view.currentEngine();
    const field = input.classList.contains(CODE_LANGUAGE_CLASS) ? 'language' : 'name';
    const value =
      composing || !engine ? input.value : engine.typedCodeBlockField(field, input.value);
    if (value !== input.value) {
      const caret = (input.selectionStart ?? value.length) - (input.value.length - value.length);
      input.value = value;
      input.setSelectionRange(Math.max(0, caret), Math.max(0, caret));
    }
    sizeCodeField(input);
  }

  /** The copy button keeps the focus where it is. A read-only note's fields take no focus. */
  private mouseDown(event: MouseEvent): void {
    const target = event.target;
    if (!isCodeHeaderControl(target)) return;
    if (target instanceof HTMLButtonElement || !this.view.dom.isContentEditable) {
      event.preventDefault();
    }
  }

  private click(event: MouseEvent): void {
    const copy = event.target;
    if (!(copy instanceof HTMLButtonElement) || !isCodeHeaderControl(copy)) return;
    const text = codeBlockText(this.view, this.codeStart(codeHeaderOf(copy)!));
    void this.copyCode(text).then((copied) => copied && flashCopied(copy));
  }

  /** Write the header, then give the editor focus with the caret where `exit` says. */
  private leave(event: KeyboardEvent, header: HTMLElement, exit: FieldExit): void {
    event.preventDefault();
    this.editing = null;
    this.write(header);
    const view = this.view;
    const at = this.codeStart(header);
    view.focus(false);
    if (exit === 'back') view.selection.showEngineSelection();
    if (exit === 'code') view.selection.select(at, at, { arrival: { kind: 'landed' } });
    if (exit !== 'above') return;
    const above = view.displayLines()[view.lineAt(at) - 1];
    const end = above.start + above.text.length;
    view.selection.select(end, end, { arrival: { kind: 'landed' } });
  }

  /** Write the header's fields to its block through the engine: a value it refuses, as one it
   *  takes, leaves the fields showing what the block has. Also ends a language caret. A header
   *  an edit or a switch took out of the editor is not written; the editor's teardown runs
   *  with the editor already out of the page, so it is asked of the editor, not the page. */
  private write(header: HTMLElement): void {
    if (!this.view.dom.contains(header) || this.view.dom.contentEditable !== 'true') return;
    const view = this.view;
    const model = view.lineModel();
    const { name, language } = codeHeaderControls(header);
    if (!model) return;
    const at = model.toByte(this.codeStart(header));
    const values = { at, language: language.value, name: name.value.trim() };
    view.run((engine) => engine.setCodeBlockHeader(values), false);
    name.value = header.getAttribute('data-name') ?? '';
    language.value = header.getAttribute('data-language') ?? '';
    sizeCodeField(name);
    sizeCodeField(language);
  }

  /** The UTF-16 offset where the code of `header`'s block starts. */
  private codeStart(header: HTMLElement): number {
    return this.view.offsetOf(header.parentNode!, 0);
  }
}
