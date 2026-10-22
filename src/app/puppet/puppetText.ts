// The document addressing both kinds of text verb share: anchors that cannot go stale, and
// ranges proved by `expect`/`docVersion`. Positions are ProseMirror's own (puppetLines.ts).
// Real input (Type, Paste, Select) and the fast writes (puppetFastWrites.ts) differ in how
// text arrives, never in how a place in the document is named. A place is acted on only
// while it is on screen, as a person acts on it: a refusal says how to bring it there.
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';

import {
  isPuppetOutcome,
  puppetRefusal as refuse,
  type Args,
  type PuppetEditorProvider,
  type PuppetOutcome,
  type PuppetParams,
} from './puppetRegistry';
import { documentText, positionOfTextIndex, textBetween, type ModelLine } from './puppetLines';
import {
  linesOnScreen,
  noteLines,
  shownLines,
  type NoteLines,
  type OnScreen,
} from './puppetNoteLines';

/** What an editor verb does to the view: a refusal, the fields its receipt adds, or nothing. */
export type EditorAct = (
  view: EditorView,
  editor: PuppetEditorProvider,
  args: Args,
) => PuppetOutcome | Record<string, unknown> | void;

const versions = new WeakMap<ProseNode, number>();

/** FNV-1a: `text` folded into `hash`. */
function fold(hash: number, text: string): number {
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * FNV-1a over the whole document, attributes and marks included: equal documents, equal
 * versions. Each node's hash is kept, and ProseMirror shares the nodes an edit did not touch
 * between documents, so a new version costs what changed, not the note.
 */
export function docVersionOf(node: ProseNode): number {
  const cached = versions.get(node);
  if (cached !== undefined) return cached;
  let hash = fold(fold(0x811c9dc5, node.type.name), JSON.stringify(node.attrs));
  for (const mark of node.marks) hash = fold(hash, JSON.stringify(mark.toJSON()));
  if (node.isText) hash = fold(hash, node.text ?? '');
  node.forEach((child) => {
    hash = Math.imul(hash ^ docVersionOf(child), 0x01000193) >>> 0;
  });
  versions.set(node, hash);
  return hash;
}

export interface Range {
  from: number;
  to: number;
}

/** Every occurrence of `needle` in the text of `lines`, as ranges. */
function textMatches(lines: readonly ModelLine[], needle: string): Range[] {
  const { text, starts } = documentText(lines);
  const matches: Range[] = [];
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
    matches.push({
      from: positionOfTextIndex(lines, starts, index, -1),
      to: positionOfTextIndex(lines, starts, index + needle.length, 1),
    });
  }
  return matches;
}

/** `refuse`, with the batch that brings the place on screen for `futo-puppet` to print. */
function refuseOffScreen(error: string, reach: unknown[]): PuppetOutcome {
  return { status: 409, body: { ok: false, error, reach } };
}

/** "lines 12–40 show": what is on screen, for a refusal. */
export function whatShows(onScreen: OnScreen | null): string {
  return onScreen ? `lines ${onScreen.first}–${onScreen.last} show` : 'no line of the note shows';
}

/** Whether line `number` is one of the lines on screen. */
export function showsLine(onScreen: OnScreen | null, number: number): boolean {
  return onScreen !== null && number >= onScreen.first && number <= onScreen.last;
}

/** The text between two positions, as far as it shows on screen. */
export function shownTextBetween(
  note: NoteLines,
  onScreen: OnScreen | null,
  from: number,
  to: number,
): string {
  const shown = shownLines(note, onScreen);
  if (shown.length === 0) return '';
  const start = Math.max(from, shown[0].at);
  const end = Math.min(to, shown[shown.length - 1].end);
  return end > start ? textBetween(shown, start, end) : '';
}

/**
 * The batch that brings the first occurrence of `needle` on screen: ScrollToLine to its line,
 * as a scroll wheel would. Find stays a verb of its own; it is not the way back, because it
 * folds case and stops at chips, so it can land on another occurrence.
 */
function textReach(note: NoteLines, needle: string): unknown[] | null {
  const [first] = textMatches(note.slice(1, note.count), needle);
  return first ? [['ScrollToLine', { line: note.at(first.from)!.line }]] : null;
}

/**
 * The single occurrence of a literal string that starts on screen, as a range.
 *
 * A position is only true for one version of the document: the moment an earlier
 * edit lands, every position after it has moved, and a batch that reuses one
 * formats the wrong word without any error (a measured evaluation lost a task
 * exactly this way). A text anchor cannot go stale, and an ambiguous one is
 * refused with every match's position rather than guessed at. It may run on below
 * the screen, as a drag's autoscroll would take it. Text off screen is refused
 * with the way to bring it there.
 */
export function anchorRange(view: EditorView, key: string, needle: string): Range | PuppetOutcome {
  if (needle === '') return refuse(400, `"${key}" cannot be the empty string`);
  const note = noteLines(view.state.doc);
  const onScreen = linesOnScreen(view, note);
  const shown = onScreen
    ? textMatches(
        note.slice(onScreen.first, onScreen.last + needle.split('\n').length - 1),
        needle,
      ).filter((match) => match.from <= note.line(onScreen.last)!.end)
    : [];
  if (shown.length > 1) {
    return refuse(
      409,
      `${shown.length} occurrences of ${JSON.stringify(needle)} on screen (at ${shown.map((match) => match.from).join(', ')}) — extend "${key}" until it is unique, or pass the positions you mean`,
    );
  }
  if (shown.length === 1) return shown[0];
  const reach = textReach(note, needle);
  if (reach) {
    return refuseOffScreen(
      `${JSON.stringify(needle)} is not on screen (${whatShows(onScreen)})`,
      reach,
    );
  }
  return refuse(
    409,
    `no occurrence of ${JSON.stringify(needle)} in the note — "${key}" is matched literally against the text \`doc\` shows (lines joined by newlines), not the markdown`,
  );
}

/** The refusal for a line off screen: ScrollToLine brings it there, as a person scrolls. */
function lineOffScreen(onScreen: OnScreen | null, what: string, line: number) {
  return refuseOffScreen(`${what} is off screen (${whatShows(onScreen)})`, [
    ['ScrollToLine', { line }],
  ]);
}

/**
 * `{"find"}` names the text, `{"from","to"}` the positions; one or the other, never both.
 * Positions pass the guards every positioned verb shares (`rangeRefusal`).
 */
export function rangeFrom(view: EditorView, args: Args, verb: string): Range | PuppetOutcome {
  const hasPositions = typeof args.from === 'number' || typeof args.to === 'number';
  if (typeof args.find === 'string') {
    if (hasPositions) return refuse(400, `${verb}: give either "find" or "from"/"to", not both`);
    return anchorRange(view, 'find', args.find);
  }
  if (typeof args.from !== 'number' || typeof args.to !== 'number') {
    return refuse(
      400,
      `${verb} needs {"from","to"} (positions from \`doc\`) or {"find":"<exact text>"} (the text itself, which no later edit can shift)`,
    );
  }
  return rangeRefusal(view, args.from, args.to, args) ?? { from: args.from, to: args.to };
}

/**
 * The guards every positioned verb shares: in the document, the same version, its start on
 * screen, the expected text. Only the start: the hand starts there, and the far end may lie
 * off screen, as a drag's autoscroll takes it.
 */
export function rangeRefusal(
  view: EditorView,
  from: number,
  to: number,
  args: Args,
): PuppetOutcome | null {
  const { doc } = view.state;
  if (from < 0 || to < from || to > doc.content.size) {
    return refuse(
      400,
      `range ${from}-${to} is not in the note: \`doc\` gives the positions on screen`,
    );
  }
  // A stale version first: its positions say nothing of this one, on screen or off.
  if (typeof args.docVersion === 'number' && args.docVersion !== docVersionOf(doc)) {
    return refuse(409, `document changed: docVersion is now ${docVersionOf(doc)}`);
  }
  const note = noteLines(doc);
  const onScreen = linesOnScreen(view, note);
  const start = note.at(from);
  if (start && !showsLine(onScreen, start.line)) {
    return lineOffScreen(onScreen, `position ${from} (line ${start.line})`, start.line);
  }
  if (typeof args.expect === 'string') {
    const actual = textBetween(note.between(from, to), from, to);
    if (args.expect !== actual) {
      const shown = shownTextBetween(note, onScreen, from, to);
      return refuse(
        409,
        `text at ${from}-${to} is ${JSON.stringify(shown)}${shown === actual ? '' : '…'}, expected ${JSON.stringify(args.expect)}`,
      );
    }
  }
  return null;
}

/** The 1-based line, anywhere in the note: what ScrollToLine scrolls to, MoveBlock drops beside. */
export function documentLineOrRefusal(view: EditorView, number: number): ModelLine | PuppetOutcome {
  const note = noteLines(view.state.doc);
  return (
    note.line(number) ??
    refuse(400, `line ${number} is not in the note: \`doc\` numbers the lines on screen`)
  );
}

/** The 1-based line, on screen: a 400 outside the note, a 409 off screen. */
export function lineOrRefusal(view: EditorView, number: number): ModelLine | PuppetOutcome {
  const entry = documentLineOrRefusal(view, number);
  if (isPuppetOutcome(entry)) return entry;
  const onScreen = linesOnScreen(view, noteLines(view.state.doc));
  return showsLine(onScreen, number) ? entry : lineOffScreen(onScreen, `line ${number}`, number);
}

export const TEXT_PARAMS: PuppetParams = { text: 'string' };
