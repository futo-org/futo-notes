/* The editor's text input: every `beforeinput`, paste, copy and cut goes to the engine, and
 * the browser edits nothing itself (an input method's composition aside, composition.ts). */
import type { DisplayRange, InputAction } from '@futo-notes/editor/wasm-payloads';
import type { EditorView } from './view';

export class EditorInput {
  constructor(private readonly view: EditorView) {}

  beforeInput(event: InputEvent): void {
    const view = this.view;
    if (!view.takesInput()) return event.preventDefault();
    if (event.inputType === 'insertCompositionText') return view.composition.target(event);
    if (view.isComposing()) return;
    event.preventDefault();
    // `selectionchange` is not sent when the selection is set to where it already is.
    const selection = view.selection.sync();
    if (!selection) return;
    const text = event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
    const replace = (range: DisplayRange | null, text: string, action: InputAction): void => {
      // An empty range with nothing to insert is no edit (and no Undo step).
      if (range && (range.start !== range.end || text !== '')) {
        view.run((engine) => engine.replace(range, text, action));
      }
    };
    switch (event.inputType) {
      // An insertText with no text is no edit, never a deletion of the selection. A typed key
      // takes the engine's paired typing (a backtick's pair, step over and code block).
      case 'insertText':
        return text ? replace(selection, text, 'PairedTyping') : undefined;
      case 'insertReplacementText':
        return replace(view.targetRange(event), text, 'Isolated');
      case 'insertParagraph':
        return view.run((engine) => engine.paragraphKey(selection, 'Enter'));
      case 'insertLineBreak':
        return view.run((engine) => engine.paragraphKey(selection, 'ShiftEnter'));
      case 'deleteContentBackward':
        return view.run((engine) => engine.paragraphKey(selection, 'PairedBackspace'));
      case 'deleteContentForward':
        return view.run((engine) => engine.paragraphKey(selection, 'Delete'));
      case 'historyUndo':
        return view.run((engine) => engine.undo());
      case 'historyRedo':
        return view.run((engine) => engine.redo());
      // Option+Backspace (Ctrl off Apple) takes the engine's words, not the browser's.
      case 'deleteWordBackward':
      case 'deleteWordForward': {
        const forward = event.inputType === 'deleteWordForward';
        if (selection.start !== selection.end) return replace(selection, '', 'Isolated');
        const stop = view.wordStop(selection.start, forward);
        const range = forward
          ? { start: selection.start, end: stop }
          : { start: stop, end: selection.start };
        return replace(range, '', 'Isolated');
      }
      // Cut is the `cut` event's edit; a drag's half-move is never one (see `dragstart`).
      case 'deleteByCut':
      case 'deleteByDrag':
        return;
      default:
        if (event.inputType.startsWith('delete'))
          return replace(view.targetRange(event), '', 'Isolated');
    }
  }

  /** The clipboard's plain text goes to the engine, which reads it as Markdown. Paste and
   *  Match Style (WebKit's `pasteAsPlainText:`) is the same paste. */
  paste(event: ClipboardEvent): void {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const view = this.view;
    const selection = view.selection.sync();
    if (!text || !selection) return;
    const range = view.bytes(selection);
    view.run((engine) => {
      const noteId = view.noteId();
      if (range.start !== range.end && noteId !== null) {
        const destination = engine.externalLinkUrl(engine.normalizeLinkDestination(noteId, text));
        if (destination && view.formatting.allows('Link'))
          return engine.setLink(range, destination);
      }
      return engine.paste(range, text);
    });
  }

  /** Copy and cut carry the selection's exact source, markers and all. */
  copy(event: ClipboardEvent, cut: boolean): void {
    event.preventDefault();
    const view = this.view;
    if (cut && !view.takesInput()) return;
    const selection = view.selection.sync();
    if (!selection || selection.start === selection.end) return;
    const range = view.bytes(selection);
    if (!cut) {
      const markdown = view.copy(range);
      if (markdown !== null) event.clipboardData?.setData('text/plain', markdown);
      return;
    }
    view.run((engine) => {
      const [markdown, applied] = engine.cut(range);
      event.clipboardData?.setData('text/plain', markdown);
      return applied;
    });
  }
}
