/* The desktop editor's DOM: one element per display line, grouped in chunks
 * (lineElements.ts), inside a contenteditable whose every input is intercepted in
 * `beforeinput` and answered by the engine. The browser edits the DOM only while an IME
 * composes; the engine's change then replaces what it drew. The caret is ours (the native
 * one is transparent), and so is the selection's highlight; the selection is the engine's
 * (selection.ts). A code block's header fields and copy button are in the editor but not the note:
 * their events are the header's (codeBlockHeader.ts), never the note's input. */
import type { Applied, DisplayRange } from '@futo-notes/editor/wasm-payloads';
import { listenForFocusChange } from '$shared/dom/listenForFocusChange';
import type { Engine } from './engine';
import { LineModel, type Line } from './lineModel';
import type { Caret } from './caret';
import { chunked, drawLine, offsetOf, pointAt } from './lineElements';
import { applyViewChanges } from './applyViewChanges';
import { EditorKeys } from './keys';
import { EditorInput } from './input';
import { EditorComposition } from './composition';
import { EditorPointer } from './pointer';
import { EditorHitTest } from './hitTest';
import { EditorFormatting } from './formatting';
import { EditorCaretSide } from './caretSide';
import { EditorOverlays, type ToolbarState } from './overlays';
import { EditorSelection } from './selection';
import { EditorCodeHeader } from './codeBlockHeader';
import { isCodeHeaderControl } from './codeBlockChrome';
import { listenEdgeLabelReveal } from './codeBlockEdgeReveal';
import { KeystrokeTimings } from './timings';
import { EditorFind } from './findInNote';
import type { FindBarState } from '$features/editor/milkdown/find';
import { EditorPictures, type ImageUrls } from './pictureLoading';
import { EditorCodeColours } from './codeColours';
import { LinkPress, type LinkOpening } from './linkPress';
import { EditorLinkPrompt } from './linkPrompt';
import { WikilinkCompletion } from './wikilinkCompletion';
import { TypedWikilink } from './typedWikilink';
import { EditorImageInput } from './imageInput';
import { SlashMenu } from './slashMenu';
import { EditorTables } from './editorTables';
import type { TableGripsState } from './tableGrips';

export interface ViewHost {
  /** An edit the view has already shown; its request goes to the note host. */
  edited(applied: Applied): void;
  focusChanged(focused: boolean): void;
  compositionEnded(): void;
  /** The selection toolbar's state, null to hide it (FormatToolbar.svelte). */
  toolbar(state: ToolbarState | null): void;
  /** Put a code block's code on the clipboard and say so; true when it is there. */
  copyCode(text: string): Promise<boolean>;
  /** Find's bar: what it shows (findInNote.ts). */
  findBar?(state: FindBarState): void;
  /** What images' pictures load (pictureLoading.ts); without it none loads. */
  images?: ImageUrls;
  /** A press opened a link (linkPress.ts). */
  openLink(opening: LinkOpening): void;
  /** The open note's id: a link's destination is read from its folder. */
  noteId(): string | null;
  /** The table grips' state, null to hide them (TableGrips.svelte). */
  tableGrips?(state: TableGripsState | null): void;
}

export class EditorView {
  readonly dom: HTMLElement;
  readonly timings = new KeystrokeTimings();
  readonly overlays: EditorOverlays;
  private readonly caret: Caret;
  private readonly keys = new EditorKeys(this);
  private readonly input = new EditorInput(this);
  readonly composition = new EditorComposition(this, () => this.engine);
  readonly pointer = new EditorPointer(this);
  readonly hitTest = new EditorHitTest(this);
  readonly formatting = new EditorFormatting(this);
  readonly caretSide = new EditorCaretSide(this);
  readonly selection = new EditorSelection(this);
  readonly codeHeader: EditorCodeHeader;
  readonly find: EditorFind;
  readonly codeColours = new EditorCodeColours(this);
  readonly linkPress: LinkPress;
  readonly linkPrompt = new EditorLinkPrompt(this);
  readonly completion = new WikilinkCompletion(this);
  readonly typedWikilink = new TypedWikilink(this);
  readonly imageInput = new EditorImageInput(this);
  readonly slashMenu = new SlashMenu(this);
  readonly tables: EditorTables;
  private engine: Engine | null = null;
  private readonly = false;
  private model: LineModel | null = null;
  private elements: HTMLElement[] = [];
  private readonly cleanup: Array<() => void> = [];
  private showSelectionOnFocus = true;

  constructor(
    private readonly wrap: HTMLElement,
    private readonly host: ViewHost,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'desktop-editor';
    this.dom.contentEditable = 'true';
    this.dom.spellcheck = false;
    this.dom.setAttribute('role', 'textbox');
    this.dom.setAttribute('aria-multiline', 'true');
    this.dom.setAttribute('autocorrect', 'on');
    this.dom.setAttribute('autocapitalize', 'sentences');
    this.dom.setAttribute('writingsuggestions', 'false');
    wrap.append(this.dom);
    this.codeHeader = new EditorCodeHeader(this, (text) => host.copyCode(text));
    this.linkPress = new LinkPress(this, (opening) => host.openLink(opening));
    this.cleanup.push(this.codeHeader.listen(this.dom));
    this.cleanup.push(listenEdgeLabelReveal(this.dom));
    this.cleanup.push(new EditorPictures(this.dom, host.images, () => this.redraw()).listen());
    this.overlays = new EditorOverlays(this, wrap, this.timings, (state) => host.toolbar(state));
    this.caret = this.overlays.caret;
    this.tables = new EditorTables(this, wrap, (state) => host.tableGrips?.(state));
    this.cleanup.push(this.tables.listen(this.dom));
    this.find = new EditorFind(this, wrap, (state) => host.findBar?.(state));
    this.listen(this.dom, 'beforeinput', (event) => this.input.beforeInput(event as InputEvent));
    this.listen(this.dom, 'keydown', (event) => {
      this.keys.keyDown(event as KeyboardEvent);
      this.caret.restartBlink();
    });
    this.listen(this.dom, 'paste', (event) => {
      if (!this.takesInput()) return event.preventDefault();
      if (!this.imageInput.paste(event as ClipboardEvent))
        this.input.paste(event as ClipboardEvent);
    });
    this.listen(this.dom, 'dragover', (event) => this.imageInput.dragOver(event as DragEvent));
    this.listen(this.dom, 'drop', (event) => this.imageInput.drop(event as DragEvent));
    this.cleanup.push(this.imageInput.listenForWindowDrops());
    this.listen(this.dom, 'copy', (event) => this.input.copy(event as ClipboardEvent, false));
    this.listen(this.dom, 'cut', (event) => this.input.copy(event as ClipboardEvent, true));
    // Dragged text moves through the pointer (pointer.ts); the browser's own drag would only
    // delete the text at its source (its drop is not an edit the engine knows).
    this.listen(this.dom, 'dragstart', (event) => event.preventDefault());
    this.listen(this.dom, 'compositionstart', () => this.composition.start());
    this.listen(this.dom, 'compositionupdate', (event) =>
      this.composition.update((event as CompositionEvent).data),
    );
    this.listen(this.dom, 'compositionend', (event) => {
      if (!this.composition.end((event as CompositionEvent).data)) return;
      this.caret.restartBlink();
      this.host.compositionEnded();
    });
    this.listen(this.dom, 'pointerdown', () => this.caret.restartBlink());
    this.listen(this.dom, 'mousedown', (event) => {
      this.keys.forgetColumn();
      this.pointer.down(event as MouseEvent);
    });
    this.cleanup.push(listenForFocusChange(this.dom, (focused) => this.focusChange(focused)));
    this.listen(document, 'selectionchange', () => this.selectionChange());
    // The highlight draws the lines near the screen: a scroll brings others there.
    this.listen(
      document,
      'scroll',
      () => (this.selection.selectsText() || this.find.isOpen()) && this.caret.schedule(),
      true,
    );
    const resize = new ResizeObserver(() => this.caret.schedule());
    resize.observe(this.dom);
    this.cleanup.push(() => resize.disconnect());
    // A face that loads after the text drew (italic, a heading's bold) moves the glyphs.
    if (document.fonts) this.listen(document.fonts, 'loadingdone', () => this.caret.schedule());
  }

  /** Listen on `target`; on the editor, never to its code block headers' controls. */
  private listen(
    target: EventTarget,
    type: string,
    handler: (event: Event) => void,
    capture = false,
  ): void {
    const listener =
      target === this.dom
        ? (event: Event) => {
            if (!isCodeHeaderControl(event.target)) handler(event);
          }
        : handler;
    target.addEventListener(type, listener, { capture, passive: type === 'scroll' });
    this.cleanup.push(() => target.removeEventListener(type, listener, { capture }));
  }

  /** Show a newly opened note's engine. */
  open(engine: Engine | null): void {
    this.linkPrompt.dismiss();
    this.completion.close();
    this.slashMenu.close();
    this.typedWikilink.forget();
    this.engine = engine;
    this.composition.reset();
    this.find.noteOpened();
    this.timings.clear();
    this.keys.forgetColumn();
    this.selection.reset(engine);
    this.model = engine ? LineModel.from(engine.projectAll()) : null;
    this.elements = (this.model?.lines ?? []).map((line) => {
      const element = document.createElement('div');
      drawLine(element, line);
      return element;
    });
    // The native selection is a live Range in the old lines (lineElements.ts
    // `withMeasuringRange`); the engine's is shown again below.
    this.selection.clearNativeSelection();
    this.dom.replaceChildren(...chunked(this.elements));
    this.setReadonly(this.readonly);
    if (document.activeElement === this.dom) this.selection.showEngineSelection();
    this.codeHeader.followLanguageCaret();
    this.caret.restartBlink();
    this.codeColours.open();
  }

  /** Draw the caret, its flag, the highlight and the toolbar again on the next frame. */
  redraw(): void {
    this.caret.schedule();
  }

  setReadonly(readonly: boolean): void {
    this.readonly = readonly;
    this.dom.contentEditable = this.engine && !readonly ? 'true' : 'false';
    // What is drawn over the text follows (the table grips go with editing).
    this.redraw();
  }

  isComposing(): boolean {
    return this.composition.active();
  }

  /** Paste `text` as Markdown at the engine's selection. */
  insert(text: string): void {
    this.selection.sync();
    this.run((engine) => engine.paste(this.selection.bytes(), text));
  }

  destroy(): void {
    this.pointer.destroy();
    this.codeColours.destroy();
    this.linkPress.destroy();
    this.completion.destroy();
    this.slashMenu.destroy();
    this.overlays.destroy();
    for (const undo of this.cleanup) undo();
    this.wrap.replaceChildren();
  }

  /** Text input, a paste and a cut edit the note only while the editor itself has focus:
   *  WebKit hands them to the editable the selection is in wherever the focus is. */
  takesInput(): boolean {
    return document.activeElement === this.dom;
  }

  hasFocus(): boolean {
    return document.activeElement === this.dom && document.hasFocus();
  }

  /** Take focus, showing the engine's selection; a press passes false, as it selects
   *  itself and WebKit would scroll to the selection shown first. */
  focus(showSelection = true): void {
    this.showSelectionOnFocus = showSelection;
    this.dom.focus({ preventScroll: true });
    this.showSelectionOnFocus = true;
  }

  /** Bring the caret into the pane on its next draw: after a move the editor steps itself,
   *  where WebKit's own step would have scrolled to it. */
  followCaret(): void {
    this.caret.follow();
  }

  /** The word a double click at UTF-16 `offset` selects (the engine's words). */
  wordAt(offset: number): DisplayRange {
    const model = this.model!;
    const range = this.engine!.wordAt(model.toByte(offset));
    return { start: model.toUtf16(range.start), end: model.toUtf16(range.end) };
  }

  /** Where a word motion from UTF-16 `offset` stops. */
  wordStop(offset: number, forward: boolean): number {
    const model = this.model!;
    return model.toUtf16(this.engine!.wordStop(model.toByte(offset), forward));
  }

  /** The exact source of a display range (in bytes); null with no note open. */
  copy(range: DisplayRange): string | null {
    return this.engine?.copy(range) ?? null;
  }

  /** The engine revision the view shows. */
  revision(): number {
    return this.engine?.revision ?? 0;
  }

  /** The index of the display line holding UTF-16 `offset`. */
  lineAt(offset: number): number {
    return this.model?.lineAt(offset) ?? 0;
  }

  /** One element per display line, in order. */
  lineElements(): readonly HTMLElement[] {
    return this.elements;
  }

  /** The lines as the page shows them, in both of the engine's units; null with no note. */
  lineModel(): LineModel | null {
    return this.model;
  }

  /** The open note's id; null with none open. */
  noteId(): string | null {
    return this.host.noteId();
  }

  /** The open note's engine, for reads; edits go through `run`. */
  currentEngine(): Engine | null {
    return this.engine;
  }

  /** The note's text as the page shows it, for reads; edits go through the engine. */
  displayLines(): readonly Line[] {
    return this.model?.lines ?? [];
  }

  offsetOf(node: Node, offset: number): number {
    return offsetOf(this.dom, this.model!, node, offset);
  }

  /** The DOM point at UTF-16 `offset`; `before`, at a format's edge, in the text before it. */
  pointAt(offset: number, before = false): [Node, number] {
    return pointAt(this.elements, this.model!, offset, before);
  }

  /** Show the edits the engine made for one input, then hand them to the host. The page shows
   *  the selection only while the editor has focus (see `focusChange`); `follow` brings the
   *  caret's row into the pane. */
  private show(applied: readonly Applied[], follow = true, reported = true): void {
    const engine = this.engine;
    if (!this.model || !engine) return;
    const changes = applied.map((one) => one.change);
    // Input with no edit can still move the selection (a letter typed over itself) or the
    // caret's side (a backtick at inline code's end), or select a code block (a Backspace
    // after it), which the session is read for.
    const last = changes[changes.length - 1];
    const answer = last
      ? {
          selection: last.selection,
          affinity: last.affinity,
          block: last.selected_block,
          writesLanguage: last.writes_language,
          writesDelimiterRow: last.writes_delimiter_row,
        }
      : {
          selection: engine.selection(),
          affinity: engine.affinity(),
          block: engine.selectedBlock(),
          writesLanguage: engine.writesLanguage(),
          writesDelimiterRow: engine.writesDelimiterRow(),
        };
    if (changes.length === 0 && !this.selection.differs(answer)) return;
    // `elements` is spliced in place: it is the array the view holds.
    applyViewChanges({
      elements: this.elements,
      model: this.model,
      changes,
      project: (range) => engine.project(range),
      onSpliced: this.codeColours.spliced,
    });
    this.selection.accept(answer);
    if (changes.length > 0) this.overlays.edited();
    else this.overlays.moved();
    if (changes.length > 0) this.find.edited();
    if (reported) for (const one of applied) this.host.edited(one);
    this.caret.restartBlink();
    if (follow) this.caret.follow();
    this.codeHeader.followLanguageCaret();
  }

  /** Show an outside change the engine adopted. It is not the user's edit, so it is never
   *  reported as one (`host.edited`), and the pane stays where it is; the caller sends it. */
  showOutsideEdit(applied: Applied): void {
    this.show([applied], false, false);
  }

  /** Run one input against the engine; a paused engine refuses it and the note stays as shown.
   *  `follow: false` for an edit away from the caret (a task's checkbox), which leaves the
   *  scroll where it is. */
  run(input: (engine: Engine) => Applied | null, follow = true): void {
    const engine = this.engine;
    if (!engine) return;
    const began = performance.now();
    try {
      const applied = input(engine);
      this.show(applied ? [applied] : [], follow);
    } catch (error) {
      console.warn('editor input refused:', error);
    }
    this.timings.input(performance.now() - began);
  }

  /** Move the UTF-16 display range `range` to `to` (drag-to-move), each edit shown. */
  moveText(range: DisplayRange, to: number): void {
    const engine = this.engine;
    const model = this.model;
    if (!engine || !model) return;
    try {
      this.show(engine.move(this.bytes(range), model.toByte(to)));
    } catch (error) {
      console.warn('editor input refused:', error);
    }
  }

  /** A UTF-16 display range in display bytes, as the engine's byte methods take it. */
  bytes(range: DisplayRange): DisplayRange {
    return { start: this.model!.toByte(range.start), end: this.model!.toByte(range.end) };
  }

  /** The range a `beforeinput` names, else the selection. */
  targetRange(event: InputEvent): DisplayRange | null {
    const [target] = event.getTargetRanges();
    if (!target) return this.selection.range();
    const anchor = this.offsetOf(target.startContainer, target.startOffset);
    const focus = this.offsetOf(target.endContainer, target.endOffset);
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  }

  private selectionChange(): void {
    if (this.isComposing() || !this.engine || !this.model) return;
    this.selection.sync();
    this.caret.restartBlink();
  }

  /** The native selection is in the editor only while it has focus: WebKit leaves it there
   *  when a press on the chrome or Tab moves focus away, and the next key would still type
   *  into the note. The engine keeps the selection, and the editor shows it again when it
   *  takes focus back, unless a press gave it (see `focus`). A window that loses focus
   *  keeps its focused element, and its selection with it. */
  private focusChange(focused: boolean): void {
    if (focused) {
      if (this.showSelectionOnFocus) this.selection.showEngineSelection();
    } else if (document.activeElement !== this.dom) {
      this.selection.clearNativeSelection();
    }
    this.host.focusChanged(focused);
    this.caret.restartBlink();
  }
}
