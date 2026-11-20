/* What the editor offers and shows of the inline formats, read from the engine: its runs
 * (lineModel.ts) for which side of a format's edge a caret joins, its active formats for a
 * caret and a selection, and which format commands would act there (`allowed`). The toolbar's
 * buttons (FormatToolbar.svelte), the caret's flag (caret.ts) and the format shortcuts
 * (keys.ts) all read these; none reads Markdown. */
import type { Affinity, InlineFormat, ToolbarCommand } from '@futo-notes/editor/wasm-payloads';
import type { BlockFormats } from './blockButtons';
import type { FormatRun, Line } from './lineModel';
import { outsideLinkEdge } from './lineLinks';

/** The toolbar's order. */
export const FORMATS: readonly InlineFormat[] = ['Bold', 'Italic', 'Strike', 'Code'];

/** The formats of the character at `at` (UTF-16 units from its line's start). */
function formatsAt(runs: readonly FormatRun[], at: number): readonly InlineFormat[] {
  for (const run of runs) {
    if (run.start > at) break;
    if (at < run.end) return run.formats;
  }
  return [];
}

/** Which side a caret between two differently formatted runs joins: the side it came from
 *  (`arrivalAffinity`), else the one with more formatting (on a tie the left), or always the
 *  left or the right one. A debug toggle. */
export type EdgeRule = 'cameFrom' | 'more' | 'left' | 'right';

/** How a caret came to rest: past a character going forward or backward; landed without
 *  passing one on its row (Up, Down, a row's start or end, a placed caret); pressed on one
 *  side of its offset; or stepped to one side of a code edge (Left and Right there). */
export type CaretArrival =
  | { kind: 'passed'; forward: boolean }
  | { kind: 'landed' }
  | { kind: 'pressed'; side: Affinity }
  | { kind: 'stepped'; side: Affinity };

/** The neighbour that supplies the formatting of a caret at `at` in `line` (UTF-16 units
 *  from its start), as the engine's affinity: at a line's start its first character. */
export function edgeAffinity(
  line: Line,
  at: number,
  rule: Exclude<EdgeRule, 'cameFrom'>,
): Affinity {
  if (at === 0 || rule === 'right') return 'Forward';
  if (rule === 'left') return 'Backward';
  const right = formatsAt(line.runs, at).length;
  return right > formatsAt(line.runs, at - 1).length ? 'Forward' : 'Backward';
}

/** Where a line's text starts: after a list item's marker. */
function textStart(line: Line): number {
  const first = line.atoms[0];
  return first?.kind === 'ListMarker' && first.start === 0 ? first.end : 0;
}

/** The engine's affinity for a caret at `at` in `line` that came there by `arrival`: past a
 *  character, that character's side; pressed or stepped, that side; landed, the character
 *  before it, at the text's start the first one. At a link's edge, by any arrival but a step,
 *  the side outside the link: a link never grows there. The debug rules other than `cameFrom`
 *  choose for every arrival but a step. */
export function arrivalAffinity(
  line: Line,
  at: number,
  arrival: CaretArrival,
  rule: EdgeRule,
): Affinity {
  if (arrival.kind === 'stepped') return arrival.side;
  const outsideLink = outsideLinkEdge(line, at);
  if (outsideLink) return outsideLink;
  if (rule !== 'cameFrom') return edgeAffinity(line, at, rule);
  if (arrival.kind === 'pressed') return arrival.side;
  if (arrival.kind === 'passed') return arrival.forward ? 'Backward' : 'Forward';
  return at === textStart(line) ? 'Forward' : 'Backward';
}

/** Where inline code starts or ends at `at` in `line`: the character before it is code and
 *  the one after it is not, or the other way round (a line's start and end count as not
 *  code). There the caret has two stops at one offset, inside the code and outside it. Null
 *  anywhere else, two code spans touching included (Linedown cannot spell them). */
export function codeEdge(line: Line, at: number): { codeBefore: boolean } | null {
  const codeBefore = formatsAt(line.runs, at - 1).includes('Code');
  return codeBefore === formatsAt(line.runs, at).includes('Code') ? null : { codeBefore };
}

/** What a selection holds: the formats it has, which a toggle turns off (the engine's
 *  `active_formats`), whether any selected character is not whitespace, and the commands that
 *  would act there (the engine's `toolbar_state` `allowed`): a format or Link left out would
 *  change nothing, so its button is disabled and its shortcut does nothing. */
export interface SelectedFormats {
  formats: readonly InlineFormat[];
  text: boolean;
  allowed: readonly ToolbarCommand[];
  /** What the selection's lines share (the engine's `toolbar_state`), for the block buttons. */
  blocks: BlockFormats;
}

/** `line`'s text with each picture's spelling blanked, its length kept. */
function textWithoutPictures(line: Line): string {
  let text = line.text;
  for (const atom of line.atoms) {
    if (!atom.image) continue;
    text = text.slice(0, atom.start) + ' '.repeat(atom.end - atom.start) + text.slice(atom.end);
  }
  return text;
}

/** Whether UTF-16 display `start`..`end` in `lines` holds a character a format could apply
 *  to, from the line at index `first` (the one holding `start`): not whitespace, not a list
 *  marker's or a divider's one character, and not a picture's spelling. Line breaks are not
 *  characters here. */
export function selectsText(
  lines: readonly Line[],
  first: number,
  start: number,
  end: number,
): boolean {
  for (let index = first; index < lines.length && lines[index].start <= end; index++) {
    const line = lines[index];
    const from = Math.max(start - line.start, 0);
    const to = Math.min(end - line.start, line.text.length);
    if (from < to && /[^\s\uFFFC]/.test(textWithoutPictures(line).slice(from, to))) return true;
  }
  return false;
}

export interface FormatButton {
  format: InlineFormat;
  /** The selection (or the caret's next character) has it: pressing turns it off. */
  lit: boolean;
  /** The engine says toggling it would change nothing there (`allowed` leaves it out). */
  disabled: boolean;
}

export function formatButtons({ formats, allowed }: SelectedFormats): FormatButton[] {
  return FORMATS.map((format) => ({
    format,
    lit: formats.includes(format),
    disabled: !allowed.includes(format),
  }));
}

const MARKS: Record<InlineFormat, string> = { Bold: 'B', Italic: 'I', Strike: 'S', Code: '<>' };

/** The caret flag's marks: the heading level, then the inline formats, in toolbar order;
 *  none in plain body text. */
export function flagMarks(formats: readonly InlineFormat[], heading: number): string[] {
  const marks = heading ? [`H${heading}`] : [];
  for (const format of FORMATS) if (formats.includes(format)) marks.push(MARKS[format]);
  return marks;
}
