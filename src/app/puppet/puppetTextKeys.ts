/* Keys and text on the desktop editor as the browser delivers them: `keydown` first, and for a
 * key the editor leaves to the browser, what the browser does with it (a `beforeinput`, or a
 * caret move the editor hands the engine). */
import type { EditorView } from '$features/editor/desktop/view';
import type { parseChord } from './puppetInput';

type Chord = Exclude<ReturnType<typeof parseChord>, string>;

export function textInput(view: EditorView, inputType: string, data: string | null = null): void {
  view.dom.dispatchEvent(
    new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true }),
  );
}

/** The key's `keydown`; true when a handler took it. */
function keyDown(view: EditorView, chord: Chord): boolean {
  const event = new KeyboardEvent('keydown', {
    key: chord.key,
    shiftKey: chord.shift,
    altKey: chord.alt,
    ctrlKey: chord.ctrl,
    metaKey: chord.meta,
    bubbles: true,
    cancelable: true,
  });
  return !view.dom.dispatchEvent(event);
}

const MOTIONS: Record<string, [direction: 'backward' | 'forward', granularity: string]> = {
  ArrowLeft: ['backward', 'character'],
  ArrowRight: ['forward', 'character'],
  ArrowUp: ['backward', 'line'],
  ArrowDown: ['forward', 'line'],
  Home: ['backward', 'lineboundary'],
  End: ['forward', 'lineboundary'],
};

function deleteKey(view: EditorView, chord: Chord, word: boolean, line: boolean): void {
  const forward = chord.key === 'Delete';
  // A word goes by the engine's words, as the editor deletes it.
  if (word && !line) return textInput(view, forward ? 'deleteWordForward' : 'deleteWordBackward');
  // A synthetic event names no range to delete: select the line first, as the browser's
  // own deletion would take it.
  const selection = document.getSelection();
  if (line && selection?.isCollapsed) {
    selection.modify('extend', forward ? 'forward' : 'backward', 'lineboundary');
  }
  textInput(view, forward ? 'deleteContentForward' : 'deleteContentBackward');
}

/** One key: the editor's keymap first, then what the browser does for a key it leaves. */
export function pressTextKey(view: EditorView, chord: Chord): void {
  if (keyDown(view, chord)) return;
  const word = chord.alt;
  const line = chord.meta || chord.ctrl;
  if (chord.key === 'Enter') {
    return textInput(view, chord.shift ? 'insertLineBreak' : 'insertParagraph');
  }
  if (chord.key === 'Backspace' || chord.key === 'Delete')
    return deleteKey(view, chord, word, line);
  const motion = MOTIONS[chord.key];
  if (motion) {
    const [direction, granularity] = motion;
    const vertical = chord.key === 'ArrowUp' || chord.key === 'ArrowDown';
    const lineMove = vertical ? 'documentboundary' : 'lineboundary';
    const by = line ? lineMove : word ? 'word' : granularity;
    document.getSelection()?.modify(chord.shift ? 'extend' : 'move', direction, by);
    return;
  }
  if ([...chord.key].length === 1 && !chord.meta && !chord.ctrl) {
    textInput(view, 'insertText', chord.key);
  }
}
