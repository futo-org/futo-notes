// The editor's reads: its part of `state`, and the `doc` and `show {"text"}` answers, from the
// desktop editor (puppetTextEditorReads.ts) where one is mounted, and a refusal where none is.
import { textEditorDoc, textEditorShow, textEditorState } from './puppetTextEditorReads';
import {
  currentScreen,
  puppetProviders,
  puppetRefusal as refuse,
  type Args,
  type PuppetOutcome,
} from './puppetRegistry';

/**
 * No editor: 503 while a note on screen is still mounting it (worth a retry), 409 on a screen
 * with no editor (waiting changes nothing).
 */
function noEditor(): PuppetOutcome {
  const screen = currentScreen();
  return screen.startsWith('editor:')
    ? refuse(503, 'the editor is still loading')
    : refuse(409, `no editor on this screen (${screen})`);
}

export function editorState(): Record<string, unknown> {
  return textEditorState();
}

/**
 * The note as a person sees it: `{}` the lines on screen, and `{"line":N}` one of them in full.
 * A line off screen is reached by scrolling or Find, as a person reaches it.
 */
export function editorDoc(args: Args): PuppetOutcome {
  if (puppetProviders.textEditor) return textEditorDoc(args);
  const unknown = Object.keys(args).find((key) => key !== 'line');
  if (unknown) return refuse(400, `doc takes {} or {"line":N}, not "${unknown}"`);
  return noEditor();
}

/** Where text on screen is, what a tap or click aimed at text (`{"text"}`) lands on. */
export function showText(text: string): PuppetOutcome {
  return puppetProviders.textEditor ? textEditorShow(text) : noEditor();
}
