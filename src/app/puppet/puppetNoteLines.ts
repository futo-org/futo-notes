// The open note's lines as an index: how many there are, line N, the line at a position, the
// lines on screen. Each top-level block's lines are kept on its node (puppetLines.ts
// `blockLines`), and ProseMirror shares the nodes an edit did not touch between documents, so a
// new version re-reads only the blocks that changed, then sums line counts — never a pass over
// every line. A line is built only when asked for.
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';

import {
  findScroller,
  getFindState,
  viewportRect,
} from '../../features/editor/milkdown/find/findPlugin';
import { getWikilinkIndex } from '../../features/notes/notes.svelte';
import type { WikilinkIndex } from '$shared/note/wikilinks';
import { blockLines, type BlockLine, type ModelLine } from './puppetLines';
import { editorOnScreen } from './puppetRegistry';

export interface NoteLines {
  /** How many lines the note has. */
  readonly count: number;
  /** Line `number`, from 1; null outside the note. */
  line(number: number): ModelLine | null;
  /** Lines `first`–`last`, within the note. */
  slice(first: number, last: number): ModelLine[];
  /** The line a position sits on: the one whose text spans it, or the next one after a gap. */
  at(pos: number): ModelLine | null;
  /** The lines a position range touches. */
  between(from: number, to: number): ModelLine[];
}

/** The last index whose value is at most `target` (values ascending), -1 when none is. */
function lastAtMost(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** A block's line, moved to where the block starts and numbered. */
function placed(entry: BlockLine, start: number, number: number): ModelLine {
  return {
    ...entry,
    at: entry.at + start,
    end: entry.end + start,
    pieces: entry.pieces.map((piece) => ({ ...piece, pos: piece.pos + start })),
    line: number,
  };
}

function index(doc: ProseNode, wikilinks: WikilinkIndex): NoteLines {
  const starts: number[] = [];
  const firsts: number[] = [];
  const parts: BlockLine[][] = [];
  let count = 0;
  doc.forEach((block, offset) => {
    const lines = blockLines(block, wikilinks);
    starts.push(offset);
    firsts.push(count);
    parts.push(lines);
    count += lines.length;
  });
  const made = new Map<number, ModelLine>();
  const line = (number: number): ModelLine | null => {
    if (!Number.isInteger(number) || number < 1 || number > count) return null;
    const known = made.get(number);
    if (known) return known;
    const block = lastAtMost(firsts, number - 1);
    const entry = placed(parts[block][number - 1 - firsts[block]], starts[block], number);
    made.set(number, entry);
    return entry;
  };
  const slice = (first: number, last: number): ModelLine[] => {
    const lines: ModelLine[] = [];
    for (let number = Math.max(1, first); number <= Math.min(last, count); number++) {
      lines.push(line(number)!);
    }
    return lines;
  };
  const at = (pos: number): ModelLine | null => {
    const block = lastAtMost(starts, pos);
    if (block >= 0) {
      const inBlock = parts[block].findIndex((entry) => pos <= entry.end + starts[block]);
      if (inBlock >= 0) return line(firsts[block] + inBlock + 1);
      return line(firsts[block] + parts[block].length + 1) ?? line(count);
    }
    return line(1);
  };
  return {
    count,
    line,
    slice,
    at,
    between: (from, to) => {
      const first = at(from);
      const last = at(to);
      if (!first || !last) return [];
      return slice(first.line, last.at > to ? last.line - 1 : last.line);
    },
  };
}

// A chip's words follow the vault as well as the document: a note created or renamed elsewhere
// can turn a broken link into a working one, so the index is kept per vault index too.
const indexes = new WeakMap<ProseNode, { wikilinks: WikilinkIndex; note: NoteLines }>();

/** The note's lines, numbered from 1. */
export function noteLines(doc: ProseNode): NoteLines {
  const wikilinks = getWikilinkIndex();
  const cached = indexes.get(doc);
  if (cached?.wikilinks === wikilinks) return cached.note;
  const note = index(doc, wikilinks);
  indexes.set(doc, { wikilinks, note });
  return note;
}

/** The first number in 1…`count` from which `holds` is true for every line, `count + 1` when never. */
function firstWhere(note: NoteLines, holds: (entry: ModelLine) => boolean): number {
  let low = 1;
  let high = note.count + 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (holds(note.line(middle)!)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** The overflow values that cut off what lies outside an element's box. */
const CLIPS = new Set(['auto', 'scroll', 'hidden', 'clip']);

/**
 * The band of the editor a person can see, in viewport px, null when none of it shows (the
 * editor stays mounted behind home): the view's box cut by every ancestor that clips it, by
 * the visual viewport, which a phone's keyboard shrinks, and by a Find bar over the bottom of
 * the scroller (findPlugin.ts `overlayInset`). The root element's overflow is the viewport's,
 * not a clip of its own box, which a phone's WebView sizes to nothing (editor.html).
 */
export function visibleBand(view: EditorView): { top: number; bottom: number } | null {
  if (!editorOnScreen()) return null;
  let { top, bottom } = view.dom.getBoundingClientRect();
  const root = view.dom.ownerDocument.documentElement;
  for (let node = view.dom.parentElement; node && node !== root; node = node.parentElement) {
    if (!CLIPS.has(getComputedStyle(node).overflowY)) continue;
    const box = node.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  const viewport = window.visualViewport;
  top = Math.max(top, viewport?.offsetTop ?? 0);
  bottom = Math.min(bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight));
  const inset = getFindState(view.state).overlayInset;
  const scroller = inset > 0 ? findScroller(view) : null;
  if (scroller) bottom = Math.min(bottom, viewportRect(view, scroller).bottom - inset);
  return bottom > top ? { top, bottom } : null;
}

/** Lines `first`–`last`, numbered as `doc` numbers them, show on screen, wholly or in part. */
export interface OnScreen {
  first: number;
  last: number;
}

/**
 * Which lines a person looking at the editor sees, null when no note is on screen. Lines paint
 * top to bottom, so two binary searches over where they paint find the band's edges: the cost
 * follows the screen, not the note.
 */
export function linesOnScreen(
  view: EditorView,
  note: NoteLines = noteLines(view.state.doc),
): OnScreen | null {
  const band = visibleBand(view);
  if (!band || note.count === 0) return null;
  const first = firstWhere(note, (entry) => view.coordsAtPos(entry.end).bottom > band.top);
  const pastLast = firstWhere(note, (entry) => view.coordsAtPos(entry.at).top >= band.bottom);
  return first < pastLast ? { first, last: pastLast - 1 } : null;
}

/** The lines `onScreen` shows. */
export function shownLines(note: NoteLines, onScreen: OnScreen | null): ModelLine[] {
  return onScreen ? note.slice(onScreen.first, onScreen.last) : [];
}
