/* A code line's syntax colours carried over an edit, so the line typed in keeps its colours until
 * its block is read again off the keystroke path (codeColours.ts): no parse runs on a keystroke. */
import { NO_COLOURS, type ColourRun, type Line, type LineSplice } from './lineModel';

/** Give the new lines of `splice` (in `lines`, the spliced model's) the colours of `replaced`,
 *  the lines they replaced, in order: the first new line keeps the first replaced line's colours
 *  where it starts alike, the last keeps the last's where it ends alike. */
export function carryColours(
  lines: readonly Line[],
  splice: LineSplice,
  replaced: readonly Line[],
): void {
  const head = replaced[0] ?? null;
  const tail = replaced[replaced.length - 1] ?? null;
  const last = splice.added - 1;
  for (let index = 0; index <= last; index++) {
    const line = lines[splice.first + index];
    const before = index === 0 ? head : null;
    const after = index === last ? tail : null;
    line.colours = carriedColours(line.text, before, after);
  }
}

/** The colours of `text`, a new line that starts as `before` did and ends as `after` did (either
 *  may be null): runs before the common start stay, runs in the common end move with it, and the
 *  run an insertion starts inside or right after grows over the inserted text. */
export function carriedColours(
  text: string,
  before: Line | null,
  after: Line | null,
): readonly ColourRun[] {
  const head = before?.colours.length ? before : null;
  const tail = after?.colours.length ? after : null;
  if (!head && !tail) return NO_COLOURS;
  const prefix = head ? commonPrefix(head.text, text) : 0;
  let room = text.length - prefix;
  if (tail && tail === head) room = Math.min(room, tail.text.length - prefix);
  const suffix = tail ? Math.min(commonSuffix(tail.text, text), room) : 0;
  const gapEnd = text.length - suffix;
  const colours: ColourRun[] = [];
  for (const run of head?.colours ?? NO_COLOURS) {
    if (run.start >= prefix) break;
    const grows = run.end >= prefix && gapEnd > prefix;
    colours.push({ ...run, end: grows ? gapEnd : Math.min(run.end, prefix) });
  }
  if (!tail) return colours;
  const oldEnd = tail.text.length - suffix;
  for (const run of tail.colours) {
    if (run.end <= oldEnd) continue;
    const start = Math.max(run.start, oldEnd) - oldEnd + gapEnd;
    const end = run.end - oldEnd + gapEnd;
    const previous = colours[colours.length - 1];
    if (previous?.end === start && previous.className === run.className) previous.end = end;
    else colours.push({ start, end, className: run.className });
  }
  return colours;
}

function commonPrefix(first: string, second: string): number {
  const most = Math.min(first.length, second.length);
  let length = 0;
  while (length < most && first.charCodeAt(length) === second.charCodeAt(length)) length++;
  return length;
}

function commonSuffix(first: string, second: string): number {
  const most = Math.min(first.length, second.length);
  let length = 0;
  while (
    length < most &&
    first.charCodeAt(first.length - 1 - length) === second.charCodeAt(second.length - 1 - length)
  ) {
    length++;
  }
  return length;
}
