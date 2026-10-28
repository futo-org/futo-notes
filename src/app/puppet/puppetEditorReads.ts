// The editor's reads: its part of `state`, and the `doc`, `show {"text"}` and `clipboard`
// answers. Everything here speaks ProseMirror positions and the lines of puppetLines.ts. The
// note's text is read as a person reads it, only where it is on screen; everything else about
// it (which lines show, where the selection is, what changed off screen) is the app's state,
// and answers in full.
import { redoDepth, undoDepth } from '@milkdown/kit/prose/history';
import { NodeSelection, TextSelection, type Selection } from '@milkdown/kit/prose/state';
import { CellSelection } from '@milkdown/kit/prose/tables';
import type { EditorView } from '@milkdown/kit/prose/view';
import { computeActiveFormats } from '../../features/editor/milkdown/formatState';
import { wikilinkDisplay } from '../../features/editor/milkdown/wikilink/display';
import { getWikilinkIndex } from '../../features/notes/notes.svelte';

import { type ClipboardAccess, type PuppetClipboardContent } from './puppetInput';
import { lineMarkdown, lineRuns, lineTags, offsetInLine, type ModelLine } from './puppetLines';
import { linesOnScreen, noteLines, shownLines, type OnScreen } from './puppetNoteLines';
import {
  currentScreen,
  puppetProviders,
  puppetRefusal as refuse,
  isPuppetOutcome,
  ok,
  type Args,
  type PuppetEditorProvider,
  type PuppetOutcome,
} from './puppetRegistry';
import { anchorRange, docVersionOf, lineOrRefusal, shownTextBetween } from './puppetText';

const SELECTION_TEXT_LIMIT = 80;

/**
 * The editor, or a refusal: 503 while a note on screen is still mounting it (worth a retry),
 * 409 on a screen with no editor (waiting changes nothing).
 */
export function requireView(): { view: EditorView; editor: PuppetEditorProvider } | PuppetOutcome {
  const editor = puppetProviders.editor;
  const view = editor?.getView();
  if (editor && view) return { view, editor };
  const screen = currentScreen();
  return screen.startsWith('editor:')
    ? refuse(503, 'the editor is still loading')
    : refuse(409, `no editor on this screen (${screen})`);
}

function truncated(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** What `Copy` or `Cut` last took; survives switching notes, since the page does. */
let puppetClipboard: PuppetClipboardContent | null = null;

export const clipboardAccess: ClipboardAccess = {
  content: () => puppetClipboard,
  copied: (content) => {
    if (content) puppetClipboard = content;
  },
};

/** A selection that is not a range of text: a whole node, table cells, everything, a gap. */
function selectionKind(selection: Selection): string | null {
  if (selection instanceof TextSelection) return null;
  if (selection instanceof NodeSelection) return `node ${selection.node.type.name}`;
  if (selection instanceof CellSelection) return 'cells';
  return selection.constructor.name === 'AllSelection' ? 'all' : 'gap';
}

function selectionOf(view: EditorView, onScreen: OnScreen | null): Record<string, unknown> {
  const { selection, doc, storedMarks } = view.state;
  const note = noteLines(doc);
  const entry = note.at(selection.head);
  const kind = selectionKind(selection);
  return {
    anchor: selection.anchor,
    head: selection.head,
    from: selection.from,
    to: selection.to,
    empty: selection.empty,
    ...(kind ? { kind } : {}),
    // What it reads as on screen: the part outside the shown lines is not there.
    text: truncated(
      shownTextBetween(note, onScreen, selection.from, selection.to),
      SELECTION_TEXT_LIMIT,
    ),
    ...(entry ? { line: entry.line, col: offsetInLine(entry, selection.head) + 1 } : {}),
    // The toolbar's own reading of the selection: what Bold, a heading, a list would toggle.
    formats: computeActiveFormats(view, selection, storedMarks),
  };
}

export function editorState(): Record<string, unknown> {
  const editor = puppetProviders.editor;
  const view = editor?.getView();
  if (!editor || !view) return { ready: false };
  const { doc } = view.state;
  const onScreen = linesOnScreen(view, noteLines(doc));
  return {
    ready: true,
    // A large note streams its tail in after it opens (progressiveLoad.ts).
    loading: editor.loading(),
    docVersion: docVersionOf(doc),
    note: editor.note(),
    onScreen,
    selection: selectionOf(view, onScreen),
    focused: view.hasFocus(),
    find: editor.find(),
    // Held, not read off the note: cut as the selection's text is. `clipboard` reads it whole.
    clipboard: puppetClipboard ? truncated(puppetClipboard.text, SELECTION_TEXT_LIMIT) : null,
    // How many edits Undo and Redo would step through: whether an edit is undoable, and
    // how the history grouped it.
    undo: undoDepth(view.state),
    redo: redoDepth(view.state),
  };
}

/** A line as `doc` prints it: its positions, kind and text, and its saved markdown where that differs. */
export function lineView(entry: ModelLine, view: EditorView, editor: PuppetEditorProvider) {
  const md = lineMarkdown(entry, view.state.doc, (doc) => editor.serialize(doc));
  return {
    line: entry.line,
    at: entry.at,
    end: entry.end,
    kind: entry.kind,
    ...(entry.indent ? { indent: entry.indent } : {}),
    text: entry.text,
    ...(md !== null && md !== entry.text ? { md } : {}),
  };
}

/** A link to a note: the note it opens, or `broken` (its text already reads as the chip). */
function chipAsDrawn(run: Record<string, unknown>): Record<string, unknown> {
  if (run.node !== 'wikilink') return run;
  const { resolvedId } = wikilinkDisplay(String(run.target), getWikilinkIndex());
  return { ...run, ...(resolvedId ? { opens: resolvedId } : { broken: true }) };
}

/**
 * The note as a person sees it: `{}` the lines on screen, and `{"line":N}` one of them in full
 * — each run of text with its formatting and position, each inline object (a chip, an image),
 * and the `#tags` the editor paints on it. A line off screen is reached by scrolling or Find,
 * as a person reaches it.
 */
export function editorDoc(args: Args): PuppetOutcome {
  const unknown = Object.keys(args).find((key) => key !== 'line');
  if (unknown) return refuse(400, `doc takes {} or {"line":N}, not "${unknown}"`);
  const required = requireView();
  if (isPuppetOutcome(required)) return required;
  const { view, editor } = required;
  const { state } = view;
  const note = noteLines(state.doc);
  const docVersion = docVersionOf(state.doc);
  if (typeof args.line === 'number') {
    const entry = lineOrRefusal(view, args.line);
    if (isPuppetOutcome(entry)) return entry;
    return ok({
      docVersion,
      ...lineView(entry, view, editor),
      runs: lineRuns(entry).map(chipAsDrawn),
      tags: lineTags(state, entry),
    });
  }
  const onScreen = linesOnScreen(view, note);
  return ok({
    docVersion,
    onScreen,
    // A scrollbar's worth: whether more of the note lies above or below, not how much.
    more: onScreen ? { above: onScreen.first > 1, below: onScreen.last < note.count } : null,
    lines: shownLines(note, onScreen).map((entry) => lineView(entry, view, editor)),
  });
}

/** Where a range paints, in viewport CSS px, so a real tap can be aimed at text. */
function rectOfRange(view: EditorView, from: number, to: number) {
  const start = view.coordsAtPos(from, 1);
  const end = view.coordsAtPos(to, -1);
  return {
    x: Math.round(start.left),
    y: Math.round(Math.min(start.top, end.top)),
    w: Math.round(end.right - start.left),
    h: Math.round(Math.max(start.bottom, end.bottom) - Math.min(start.top, end.top)),
  };
}

/**
 * Where text on screen is: its positions, line and box, what a tap or click aimed at text
 * (`{"text"}`) lands on. Only what shows: text off screen is found as a person finds it.
 */
export function showText(text: string): PuppetOutcome {
  const required = requireView();
  if (isPuppetOutcome(required)) return required;
  const { view } = required;
  const range = anchorRange(view, 'text', text);
  if (isPuppetOutcome(range)) return range;
  const entry = noteLines(view.state.doc).at(range.from);
  return ok({
    text,
    from: range.from,
    to: range.to,
    ...(entry ? { line: entry.line, col: offsetInLine(entry, range.from) + 1 } : {}),
    rect: rectOfRange(view, range.from, range.to),
  });
}

/**
 * The puppet clipboard: `{"clear":true}` empties it (a harness resets it between tasks), and
 * `{"text":"…","html"?:"…"}` fills it as copying from another app would, for Paste to test
 * what the editor makes of outside text.
 */
export function clipboard(args: Args): PuppetOutcome {
  if (args.clear === true) puppetClipboard = null;
  if (typeof args.text === 'string') {
    puppetClipboard = { text: args.text, html: typeof args.html === 'string' ? args.html : '' };
  }
  return ok({ clipboard: puppetClipboard });
}
