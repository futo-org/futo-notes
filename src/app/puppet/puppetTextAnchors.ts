/* How the desktop editor's verbs name a place, as the other editors' do (puppetText.ts): by
 * text, which no edit can shift, or by display offsets proved with `expect` or `docVersion`.
 * Text and lines are aimed at only while they are on screen, as a person's eye finds them: a
 * refusal says how to bring them there. Offsets go anywhere, as the keys do. Text is matched literally against what `doc` shows, lines joined by newlines,
 * a list item's marker unit left out. */
import type { Line } from '$features/editor/desktop/lineModel';
import type { EditorView } from '$features/editor/desktop/view';
import type { OnScreen } from './puppetNoteLines';
import {
  isPuppetOutcome,
  puppetRefusal as refuse,
  type Args,
  type PuppetOutcome,
} from './puppetRegistry';
import { showsLine, whatShows, type Range } from './puppetText';
import { shownTextOf, textLinesOnScreen } from './puppetTextLines';

const engineIds = new WeakMap<object, number>();
let engineCount = 0;
const REVISIONS = 1e9;

/** The version of the note the view shows: its engine's identity and revision together. A
 *  revision restarts at each note, so alone it would match a read from another note. */
export function docVersionOfView(view: EditorView): number {
  const engine = view.currentEngine();
  if (!engine) return 0;
  let id = engineIds.get(engine);
  if (id === undefined) engineIds.set(engine, (id = ++engineCount));
  return id * REVISIONS + (engine.revision % REVISIONS);
}

/** `refuse`, with the batch that brings the place on screen for `futo-puppet` to print. */
function refuseOffScreen(error: string, line: number): PuppetOutcome {
  return { status: 409, body: { ok: false, error, reach: [['ScrollToLine', { line }]] } };
}

const lineOf = (view: EditorView, offset: number): number => view.lineAt(offset) + 1;

function noteEnd(view: EditorView): number {
  const lines = view.displayLines();
  const last = lines[lines.length - 1];
  return last ? last.start + last.text.length : 0;
}

/** Every occurrence of `needle` in the note's shown text, as display ranges. */
function matchesOf(view: EditorView, needle: string): Range[] {
  const { text, offsets } = shownTextOf(view.displayLines());
  const matches: Range[] = [];
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
    const last = index + needle.length - 1;
    matches.push({ from: offsets[index], to: offsets[last] + 1 });
  }
  return matches;
}

/** The text `doc` shows between two offsets. */
function shownBetween(view: EditorView, from: number, to: number): string {
  const { text, offsets } = shownTextOf(view.displayLines());
  let shown = '';
  for (let index = 0; index < text.length; index++) {
    if (offsets[index] >= from && offsets[index] < to) shown += text[index];
  }
  return shown;
}

/** The single occurrence of `needle` that starts on screen; it may run on below the screen, as
 *  a drag's autoscroll would take it. Several are refused with every position, none on screen
 *  with the batch that brings the first one there. */
export function textAnchor(view: EditorView, key: string, needle: string): Range | PuppetOutcome {
  if (needle === '') return refuse(400, `"${key}" cannot be the empty string`);
  const onScreen = textLinesOnScreen(view);
  const matches = matchesOf(view, needle);
  const shown = matches.filter((match) => showsLine(onScreen, lineOf(view, match.from)));
  if (shown.length > 1) {
    return refuse(
      409,
      `${shown.length} occurrences of ${JSON.stringify(needle)} on screen (at ${shown.map((match) => match.from).join(', ')}) — extend "${key}" until it is unique, or pass the positions you mean`,
    );
  }
  if (shown.length === 1) return shown[0];
  if (matches.length > 0) {
    return refuseOffScreen(
      `${JSON.stringify(needle)} is not on screen (${whatShows(onScreen)})`,
      lineOf(view, matches[0].from),
    );
  }
  return refuse(
    409,
    `no occurrence of ${JSON.stringify(needle)} in the note — "${key}" is matched literally against the text \`doc\` shows (lines joined by newlines), not the markdown`,
  );
}

/** The guards every positioned verb shares: in the note, the same version, the expected text.
 *  A range may run backwards (`from` after `to`), as a drag does. Offsets are not held to the
 *  screen: they are where the caret and the selection go, as the keys put them anywhere in the
 *  note; only aiming by text and by line is, as a person's eye and hand are. */
export function textRangeRefusal(view: EditorView, range: Range, args: Args): PuppetOutcome | null {
  const { from, to } = range;
  const end = noteEnd(view);
  if (Math.min(from, to) < 0 || Math.max(from, to) > end) {
    return refuse(400, `range ${from}-${to} is not in the note, which ends at ${end}`);
  }
  if (typeof args.docVersion === 'number' && args.docVersion !== docVersionOfView(view)) {
    return refuse(409, `document changed: docVersion is now ${docVersionOfView(view)}`);
  }
  if (typeof args.expect === 'string') {
    const actual = shownBetween(view, Math.min(from, to), Math.max(from, to));
    if (args.expect !== actual) {
      return refuse(
        409,
        `text at ${from}-${to} is ${JSON.stringify(actual)}, expected ${JSON.stringify(args.expect)}`,
      );
    }
  }
  return null;
}

/** `{"find"}` names the text, `{"from","to"}` the offsets; one or the other, never both. */
export function textRangeFrom(view: EditorView, args: Args, verb: string): Range | PuppetOutcome {
  const hasPositions = typeof args.from === 'number' || typeof args.to === 'number';
  if (typeof args.find === 'string') {
    if (hasPositions) return refuse(400, `${verb}: give either "find" or "from"/"to", not both`);
    return textAnchor(view, 'find', args.find);
  }
  if (typeof args.from !== 'number' || typeof args.to !== 'number') {
    return refuse(
      400,
      `${verb} needs {"from","to"} (offsets from \`doc\`) or {"find":"<exact text>"} (the text itself, which no later edit can shift)`,
    );
  }
  const range = { from: args.from, to: args.to };
  return textRangeRefusal(view, range, args) ?? range;
}

/** The 1-based line, anywhere in the note. */
export function textLineInNote(view: EditorView, number: number): Line | PuppetOutcome {
  const line = view.displayLines()[number - 1];
  return (
    line ??
    refuse(400, `line ${number} is not in the note, which has ${view.displayLines().length}`)
  );
}

/** The 1-based line, on screen: a 400 outside the note, a 409 off screen. */
export function textLineOnScreen(view: EditorView, number: number): Line | PuppetOutcome {
  const line = textLineInNote(view, number);
  if (isPuppetOutcome(line)) return line;
  const onScreen: OnScreen | null = textLinesOnScreen(view);
  return showsLine(onScreen, number)
    ? line
    : refuseOffScreen(`line ${number} is off screen (${whatShows(onScreen)})`, number);
}
