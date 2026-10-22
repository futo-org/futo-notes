// Input as a person's arrives: keys, typed characters and the clipboard, delivered as the DOM
// events ProseMirror listens for, so the editor's own handlers decide what they mean — its
// keymaps (`handleKeyDown`), its input rules (`handleTextInput`), its paste pipeline
// (`handlePaste`) and its copy serializer. Only what a browser does by itself when no handler
// claims a key (move the caret, delete a character, type it) is done here, with transactions.
import { Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import { offsetInLine, positionInLine, type ModelLine } from './puppetLines';
import { noteLines, type NoteLines } from './puppetNoteLines';

const MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

const FUNCTION_KEYS = Array.from({ length: 12 }, (_, index) => `F${index + 1}`);

/** The named keys a keyboard has. Any single character is a key too. */
const NAMED_KEYS: readonly string[] = [
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Insert',
  ...FUNCTION_KEYS,
];

/**
 * The legacy `keyCode` a real key event carries, which prosemirror-view's own arrow and delete
 * handling reads. Enter is deliberately absent: prosemirror-view hands an iOS keydown with code
 * 13 to a 200 ms fallback and ignores one on Chrome Android, so Enter goes by `key` alone.
 */
const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Shift: 16,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  ...Object.fromEntries(FUNCTION_KEYS.map((key, index) => [key, 112 + index])),
};

interface KeyChord {
  key: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

/**
 * `Enter`, `a`, `Shift-Tab`, `Mod-b`, `Mod-Shift-z`: prosemirror-keymap's own names, `Mod`
 * being Cmd on Apple platforms and Ctrl elsewhere. A string, or why it names no key.
 */
export function parseChord(spec: string): KeyChord | string {
  const parts = spec.split(/-(?!$)/);
  const key = parts.pop() ?? '';
  const chord = plainChord(key);
  for (const modifier of parts) {
    if (modifier === 'Mod') chord[MAC ? 'meta' : 'ctrl'] = true;
    else if (modifier === 'Shift') chord.shift = true;
    else if (modifier === 'Alt' || modifier === 'Option') chord.alt = true;
    else if (modifier === 'Ctrl' || modifier === 'Control') chord.ctrl = true;
    else if (modifier === 'Meta' || modifier === 'Cmd') chord.meta = true;
    else
      return `no modifier key called ${JSON.stringify(modifier)} — Mod, Shift, Alt, Ctrl or Meta`;
  }
  if ([...key].length !== 1 && !NAMED_KEYS.includes(key)) {
    return `no keyboard has a key called ${JSON.stringify(key)} — one character, or ${NAMED_KEYS.join(', ')}`;
  }
  // Shift on a letter is the capital, as a keyboard reports it.
  if (chord.shift && /^[a-z]$/.test(key)) chord.key = key.toUpperCase();
  return chord;
}

function keyCodeOf(key: string): number | undefined {
  if (/^[a-zA-Z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  return KEY_CODES[key];
}

function keyEvent(type: 'keydown' | 'keypress' | 'keyup', chord: KeyChord): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    key: chord.key,
    shiftKey: chord.shift,
    altKey: chord.alt,
    ctrlKey: chord.ctrl,
    metaKey: chord.meta,
    bubbles: true,
    cancelable: true,
  });
  const keyCode = type === 'keypress' ? undefined : keyCodeOf(chord.key);
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  if (type === 'keypress')
    Object.defineProperty(event, 'charCode', { value: chord.key.charCodeAt(0) });
  return event;
}

function plainChord(key: string): KeyChord {
  return { key, shift: false, alt: false, ctrl: false, meta: false };
}

/** What the agent last copied: the copy handler's own two flavours, as a clipboard holds them. */
export interface PuppetClipboardContent {
  text: string;
  html: string;
}

function transfer(): DataTransfer {
  if (typeof DataTransfer === 'function') return new DataTransfer();
  // No DataTransfer constructor (jsdom): the part of one the editor's handlers read.
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => void data.set(type, value),
    clearData: () => data.clear(),
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
  } as unknown as DataTransfer;
}

/** A clipboard event over `data`, dispatched where the browser dispatches one: the editable. */
function clipboardEvent(view: EditorView, type: 'copy' | 'cut' | 'paste', data: DataTransfer) {
  const init = { bubbles: true, cancelable: true };
  const event =
    typeof ClipboardEvent === 'function'
      ? new ClipboardEvent(type, { ...init, clipboardData: data })
      : new Event(type, init);
  if ((event as ClipboardEvent).clipboardData !== data) {
    Object.defineProperty(event, 'clipboardData', { value: data });
  }
  view.dom.dispatchEvent(event);
  return event;
}

/** Copy or cut the selection through the editor's own copy handler. Null when nothing is selected. */
export function copySelection(view: EditorView, cut: boolean): PuppetClipboardContent | null {
  if (view.state.selection.empty) return null;
  const data = transfer();
  clipboardEvent(view, cut ? 'cut' : 'copy', data);
  const text = data.getData('text/plain');
  const html = data.getData('text/html');
  return text === '' && html === '' ? null : { text, html };
}

/** Paste `content` at the selection through the editor's paste pipeline. */
export function paste(view: EditorView, content: PuppetClipboardContent): void {
  const data = transfer();
  if (content.html) data.setData('text/html', content.html);
  data.setData('text/plain', content.text);
  clipboardEvent(view, 'paste', data);
}

/** The line a caret can sit on, nearest `from` in `direction`: a divider has no caret position. */
function textLine(note: NoteLines, from: number, direction: -1 | 1): ModelLine | null {
  for (let entry = note.line(from); entry; entry = note.line(entry.line + direction)) {
    if (entry.textblock) return entry;
  }
  return null;
}

/** Characters a code point takes in a line's text: 2 for an astral one (an emoji). */
function charLength(text: string, offset: number, direction: -1 | 1): number {
  const code = text.charCodeAt(direction < 0 ? offset - 1 : offset);
  const isSurrogate =
    direction < 0 ? code >= 0xdc00 && code <= 0xdfff : code >= 0xd800 && code <= 0xdbff;
  return isSurrogate ? 2 : 1;
}

/** Where the browser moves the caret for an arrow, Home or End nobody claimed. Null for a no-op. */
function caretTarget(view: EditorView, key: string): number | null {
  const { doc, selection } = view.state;
  const note = noteLines(doc);
  const current = note.at(selection.head);
  if (!current) return null;
  const offset = offsetInLine(current, selection.head);
  switch (key) {
    case 'Home':
      return current.at;
    case 'End':
      return current.end;
    case 'ArrowLeft': {
      if (offset > 0)
        return positionInLine(current, offset - charLength(current.text, offset, -1), -1);
      return textLine(note, current.line - 1, -1)?.end ?? null;
    }
    case 'ArrowRight': {
      if (offset < current.text.length) {
        return positionInLine(current, offset + charLength(current.text, offset, 1), 1);
      }
      return textLine(note, current.line + 1, 1)?.at ?? null;
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      const next = textLine(
        note,
        current.line + (key === 'ArrowUp' ? -1 : 1),
        key === 'ArrowUp' ? -1 : 1,
      );
      if (!next) return key === 'ArrowUp' ? current.at : current.end;
      return positionInLine(next, Math.min(offset, next.text.length), -1);
    }
    default:
      return null;
  }
}

/** One character (or code point) of text deleted beside the caret, as the browser deletes it. */
function deleteCharacter(view: EditorView, direction: -1 | 1): void {
  const { state } = view;
  const { selection } = state;
  if (!selection.empty) {
    view.dispatch(state.tr.deleteSelection().scrollIntoView());
    return;
  }
  const head = selection.$head;
  if (!head.parent.inlineContent) return;
  const offset = head.parentOffset;
  if (direction < 0 ? offset === 0 : offset === head.parent.content.size) return;
  const text = head.parent.textBetween(
    Math.max(0, offset - 2),
    Math.min(head.parent.content.size, offset + 2),
    undefined,
    '￼',
  );
  const at = Math.min(offset, 2);
  const length = charLength(text, at, direction);
  const from = direction < 0 ? head.pos - length : head.pos;
  view.dispatch(state.tr.delete(from, from + length).scrollIntoView());
}

/** A character typed into the editor, as a keyboard delivers it after its keydown. */
function typeCharacter(view: EditorView, text: string): void {
  // One UTF-16 unit is what a keypress can carry; an emoji arrives as text input alone.
  if (text.length === 1) {
    const press = keyEvent('keypress', plainChord(text));
    view.dom.dispatchEvent(press);
    // ProseMirror's own keypress handling (handleKeyPress, or typing over a node selection).
    if (press.defaultPrevented) return;
  }
  // The browser writes the character and ProseMirror reads the change: handleTextInput first,
  // which is where every input rule lives, then a plain insert.
  const { from, to } = view.state.selection;
  const insert = () => view.state.tr.insertText(text, from, to);
  const handled = view.someProp('handleTextInput', (handler) =>
    handler(view, from, to, text, insert),
  );
  if (!handled) view.dispatch(insert().scrollIntoView());
}

/** What the browser does with a key no handler claimed. */
function defaultAction(view: EditorView, chord: KeyChord, clipboard: ClipboardAccess): void {
  const command = chord.ctrl !== chord.meta && !chord.alt;
  if (command) {
    const letter = chord.key.toLowerCase();
    if (letter === 'c' || letter === 'x') clipboard.copied(copySelection(view, letter === 'x'));
    if (letter === 'v') {
      const content = clipboard.content();
      if (content) paste(view, content);
    }
    return;
  }
  if (chord.ctrl || chord.meta) return;
  if ([...chord.key].length === 1) {
    typeCharacter(view, chord.key);
    return;
  }
  if (chord.key === 'Backspace' || chord.key === 'Delete') {
    deleteCharacter(view, chord.key === 'Backspace' ? -1 : 1);
    return;
  }
  const { doc, selection } = view.state;
  // A selection collapses to the side the arrow points at; the caret does not move on.
  const sideways = chord.key === 'ArrowLeft' ? -1 : chord.key === 'ArrowRight' ? 1 : 0;
  if (sideways && !chord.shift && !selection.empty) {
    const side = doc.resolve(sideways < 0 ? selection.from : selection.to);
    view.dispatch(view.state.tr.setSelection(Selection.near(side, sideways)).scrollIntoView());
    return;
  }
  const target = caretTarget(view, chord.key);
  if (target === null) return;
  const next = chord.shift
    ? TextSelection.create(doc, selection.anchor, target)
    : TextSelection.create(doc, target);
  view.dispatch(view.state.tr.setSelection(next).scrollIntoView());
}

/** The agent's clipboard, which Mod-c, Mod-x and Mod-v fall through to. */
export interface ClipboardAccess {
  content(): PuppetClipboardContent | null;
  copied(content: PuppetClipboardContent | null): void;
}

/** One key press: keydown where the browser sends it, the default action if nobody claimed it, keyup. */
export function pressKey(view: EditorView, chord: KeyChord, clipboard: ClipboardAccess): void {
  const down = keyEvent('keydown', chord);
  view.dom.dispatchEvent(down);
  if (!down.defaultPrevented) defaultAction(view, chord, clipboard);
  view.dom.dispatchEvent(keyEvent('keyup', chord));
  // prosemirror-view remembers Shift from keydown until Shift itself comes up; a paste while
  // it believes Shift is held pastes as plain text.
  if (chord.shift) view.dom.dispatchEvent(keyEvent('keyup', plainChord('Shift')));
}

/** Text as typed: each character a key press, a newline the Enter key and a tab the Tab key. */
export function typeText(view: EditorView, text: string, clipboard: ClipboardAccess): void {
  for (const character of text) {
    const key = character === '\n' ? 'Enter' : character === '\t' ? 'Tab' : character;
    pressKey(view, plainChord(key), clipboard);
  }
}
