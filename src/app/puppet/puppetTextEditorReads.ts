/* Puppet's reads of the desktop editor (features/editor/desktop): its part of `state`, `doc`,
 * `show {"text"}` and where a point lands, in the engine's display offsets (UTF-16), with the
 * same names as the other editors' reads. The selection is the engine's. */
import { pointInLine, withMeasuringRange } from '$features/editor/desktop/lineElements';
import { drawnLineDrift, lineModelDrift } from '$features/editor/desktop/lineDrift';
import { LineModel } from '$features/editor/desktop/lineModel';
import { scrollerOf } from '$features/editor/desktop/paneScroll';
import type { EditorView } from '$features/editor/desktop/view';
import { clipboardText } from './puppetClipboard';
import { puppetPicturesOf } from './puppetPictures';
import {
  editorOnScreen,
  isPuppetOutcome,
  ok,
  puppetProviders,
  puppetRefusal as refuse,
  type Args,
  type PuppetOutcome,
} from './puppetRegistry';
import { docVersionOfView, textLineOnScreen } from './puppetTextAnchors';
import { lineRunsOf, lineTagsOf } from './puppetTextLineRuns';
import { docTextOf, kindsOf, textLinesOnScreen } from './puppetTextLines';

export function mountedTextEditor(): EditorView | PuppetOutcome {
  const view = puppetProviders.textEditor?.view();
  return view ?? refuse(503, 'the editor is still loading');
}

function lineAndColumn(view: EditorView, offset: number): { line: number; col: number } {
  const index = view.lineAt(offset);
  return { line: index + 1, col: offset - view.displayLines()[index].start + 1 };
}

/** Where a press at viewport `x`, `y` would put the caret, as `at` and the trace report it. */
export function textEditorPositionAt(
  view: EditorView,
  x: number,
  y: number,
): { pos: number; line: number; col: number } | null {
  if (view.displayLines().length === 0) return null;
  const { offset } = view.hitTest.offsetAt(x, y, scrollerOf(view.dom), true);
  return { pos: offset, ...lineAndColumn(view, offset) };
}

/** The indices `from` to `to` of the line elements the window shows. */
function elementsOnScreen(view: EditorView): [number, number] {
  const onScreen = textLinesOnScreen(view);
  return onScreen ? [onScreen.first - 1, onScreen.last] : [0, 0];
}

/** Why the page does not draw the engine's reading of the note, or null: its lines against the
 *  engine's whole projection, then the line elements on screen against a fresh draw of their
 *  lines (an input method's composition leads while it lasts). */
function drawnDrift(view: EditorView): string | null {
  const engine = view.currentEngine();
  const model = view.lineModel();
  if (!engine || !model) return null;
  const read = LineModel.from(engine.projectAll()).lines;
  view.typedWikilink.leaveOutOf(read);
  const lines = lineModelDrift(model.lines, read);
  if (lines || view.isComposing()) return lines;
  return drawnLineDrift(view.lineElements(), model.lines, ...elementsOnScreen(view));
}

const DRIFT_ERROR = 'drawn lines differ from the engine';

/** Why the page's selection is not the engine's, or null while they agree. An input
 *  method's composition leads, and the editor without focus shows none. */
function selectionMismatch(view: EditorView): string | null {
  const ends = view.selection.ends();
  const engine = view.selection.range();
  if (!ends || !engine || view.isComposing()) return null;
  const start = Math.min(ends.anchor, ends.focus);
  const end = Math.max(ends.anchor, ends.focus);
  if (start === engine.start && end === engine.end) return null;
  return `the page selects ${start}..${end}, the engine ${engine.start}..${engine.end}`;
}

/** `state`'s `error`: what the page shows that the engine does not. */
function viewErrors(view: EditorView): { error: string } | undefined {
  const mismatch = selectionMismatch(view);
  const drift = drawnDrift(view);
  const errors = [
    // The engine's selection is the one the editor shows; the page's must be the same.
    mismatch && `selection mismatch: ${mismatch}`,
    drift && `${DRIFT_ERROR}: ${drift}`,
  ].filter((error) => !!error);
  return errors.length > 0 ? { error: errors.join('; ') } : undefined;
}

/** The display text between two offsets, `\r` kept where a line has one. */
export function displayTextBetween(view: EditorView, from: number, to: number): string {
  return view
    .displayLines()
    .map((line) => (line.cr ? `${line.text}\r` : line.text))
    .join('\n')
    .slice(from, to);
}

/** The editor's part of `state`. A receipt's copy leaves out the drift check (`error`), which
 *  projects the whole note again: a verb before typed keys would leave that garbage to them. */
export function textEditorState(
  options: { checked: boolean } = { checked: true },
): Record<string, unknown> {
  const editor = puppetProviders.textEditor;
  const view = editor?.view();
  if (!editor || !view) return { ready: false };
  const selection = view.selection.range();
  // The page's ends say which way it was made; without focus the page shows none.
  const ends = view.selection.ends();
  return {
    ready: true,
    loading: false,
    docVersion: docVersionOfView(view),
    note: editor.note(),
    onScreen: textLinesOnScreen(view),
    selection: selection && {
      from: selection.start,
      to: selection.end,
      ...(ends && { anchor: ends.anchor, head: ends.focus }),
      empty: selection.start === selection.end,
      ...lineAndColumn(view, selection.start),
      text: displayTextBetween(view, selection.start, selection.end),
      // A code block selected as one object (its whole range), not a text selection.
      ...(view.selection.selectedBlock() && { block: true }),
    },
    ...(options.checked && viewErrors(view)),
    // DOM focus, as the other editors report it: Puppet never activates the window.
    focused: document.activeElement === view.dom,
    find: view.find.puppetState(),
    clipboard: clipboardText(),
    // A code block header field with focus, and what it holds: the note then has none.
    ...(view.codeHeader.focusedField() && { headerField: view.codeHeader.focusedField() }),
    // Code block colours still to be drawn (codeColours.ts): a grammar loading, a block being read.
    ...(view.codeColours.pending() && { colouring: true }),
    caret: view.overlays.caretRect(),
    // The marks the caret's flag holds; it is drawn only with the flag switched on
    // (debugToggles.svelte.ts `showCaretFlag`), and only in a focused window.
    flag: view.overlays.flag(),
    idle: editor.idle(),
    typing: view.timings.summary(),
  };
}

/** Lines `from` to `to` (0-based, `to` excluded) as `doc` lists them: offsets, kind as drawn,
 *  text. A list item's `at` is before its marker unit, and its text starts one offset after it. */
function docLines(view: EditorView, from: number, to: number): Record<string, unknown>[] {
  const lines = view.displayLines();
  const kinds = kindsOf(lines);
  const elements = view.lineElements();
  return lines.slice(from, to).map((line, offset) => {
    const index = from + offset;
    return {
      line: index + 1,
      at: line.start,
      end: line.start + line.text.length,
      kind: kinds[index],
      // A line's display level below the first: an item's nesting, or the level an indented
      // plain line borrows from the list above it.
      ...(line.list && line.list.level > 0 ? { indent: line.list.level } : {}),
      text: docTextOf(line),
      ...(line.atoms.some((atom) => atom.image) && {
        pictures: puppetPicturesOf(line, elements[index]),
      }),
    };
  });
}

/** The lines on screen as `doc` lists them, for `step`'s observation; none off the editor. */
export function textEditorLinesOnScreen(): Record<string, unknown>[] {
  const view = puppetProviders.textEditor?.view();
  const onScreen = view && editorOnScreen() ? textLinesOnScreen(view) : null;
  return view && onScreen ? docLines(view, onScreen.first - 1, onScreen.last) : [];
}

/** `doc {"line":N}`: one line on screen, piece by piece. */
function textEditorDocLine(view: EditorView, number: number): PuppetOutcome {
  const line = textLineOnScreen(view, number);
  if (isPuppetOutcome(line)) return line;
  const element = view.lineElements()[number - 1];
  return ok({
    docVersion: docVersionOfView(view),
    line: number,
    at: line.start,
    end: line.start + line.text.length,
    kind: kindsOf(view.displayLines())[number - 1],
    text: docTextOf(line),
    runs: lineRunsOf(line, element),
    tags: lineTagsOf(line),
  });
}

/** `doc`: every display line, which of them show, and the note's source. */
export function textEditorDoc(args: Args): PuppetOutcome {
  const unknown = Object.keys(args).find((key) => key !== 'line');
  if (unknown) return refuse(400, `doc takes {} or {"line":N}, not "${unknown}"`);
  const view = mountedTextEditor();
  if (isPuppetOutcome(view)) return view;
  // Lines read from the page are only worth having while they are the engine's.
  const drift = drawnDrift(view);
  if (drift) return refuse(500, `${DRIFT_ERROR}: ${drift}`);
  if (typeof args.line === 'number') return textEditorDocLine(view, args.line);
  const lines = view.displayLines();
  const onScreen = textLinesOnScreen(view);
  return ok({
    docVersion: docVersionOfView(view),
    onScreen,
    more: onScreen ? { above: onScreen.first > 1, below: onScreen.last < lines.length } : null,
    lines: docLines(view, 0, lines.length),
    source: puppetProviders.textEditor?.source() ?? null,
  });
}

/** `show {"text"}`: where the first line holding `text` on screen draws it (viewport CSS
 *  px), what a click aimed at text (`{"text"}`) lands on, and the formats it is drawn in, read
 *  from the page: one entry per piece drawn alike, `plain` or its formats joined by `+`. */
export function textEditorShow(text: string): PuppetOutcome {
  const view = mountedTextEditor();
  if (isPuppetOutcome(view)) return view;
  const elements = view.lineElements();
  for (const [index, line] of view.displayLines().entries()) {
    const at = line.text.indexOf(text);
    if (at < 0 || text === '') continue;
    const element = elements[index];
    const rect = withMeasuringRange((range) => {
      range.setStart(...pointInLine(element, at));
      range.setEnd(...pointInLine(element, at + text.length, true));
      return range.getBoundingClientRect();
    });
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
    return ok({
      text,
      from: line.start + at,
      to: line.start + at + text.length,
      line: index + 1,
      col: at + 1,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      formats: drawnFormats(element, at, at + text.length),
    });
  }
  return refuse(404, `show: "${text}" is not on screen in one line`);
}

/** The formats a line element draws its text `from`..`to` (line UTF-16 units) in, piece by
 *  piece: a span's classes, `plain` for a bare text node. */
function drawnFormats(element: HTMLElement, from: number, to: number): string[] {
  const formats: string[] = [];
  let start = 0;
  for (const node of element.childNodes) {
    const end = start + (node.textContent ?? '').length;
    if (end > from && start < to) {
      formats.push(node instanceof HTMLElement ? node.className.split(' ').join('+') : 'plain');
    }
    start = end;
  }
  return formats;
}
