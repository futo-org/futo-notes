/**
 * Snapshots: the derived state an action is judged by — the interactable elements, the open
 * note as far as it shows, the selection — taken before and after every action, and the diff
 * between two. Ring-buffered alongside the trace (puppetTrace.ts).
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { flushSync } from 'svelte';

import { collectElements, type ElementRow, type Rect } from './puppetElements';
import { linesListing } from './puppetLines';
import { linesOnScreen, noteLines, type NoteLines, type OnScreen } from './puppetNoteLines';
import { puppetProviders, currentScreen } from './puppetRegistry';

export interface Selection {
  from: number;
  to: number;
}

export interface Snapshot {
  id: number;
  t: number;
  screen: string;
  elements: ElementRow[];
  /** The open note: which of its lines show. Its text is the diff's. */
  doc: { onScreen: OnScreen | null } | null;
  selection: Selection | null;
}

interface ElementChange {
  ref: string;
  component: string | null;
  role: string;
  text: string;
  rect?: [Rect, Rect];
  flags?: [string[], string[]];
  textChange?: [string, string];
  section?: string;
}

export interface SnapshotDiff {
  before: number;
  after: number;
  screen?: [string, string];
  elements: { added: ElementRow[]; removed: ElementRow[]; changed: ElementChange[] };
  /**
   * The line the hunk starts on, as `doc` numbers them, and what it took out and put in, as
   * far as either shows on screen; a change wholly off screen is only where it is, lines
   * `line`–`to` of the note after it, as a person sees nothing of it.
   */
  doc?:
    | { line: number; removed: string; inserted: string }
    | { line: number; to: number; offScreen: true };
  selection?: [Selection | null, Selection | null];
}

const SNAPSHOT_LIMIT = 40;
const DIFF_TEXT_LIMIT = 200;

const snapshots: Snapshot[] = [];
let nextSnapshotId = 1;

export const now = (): number => Math.round(performance.now());

export function push<T>(buffer: T[], item: T, limit: number): T {
  buffer.push(item);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  return item;
}

export function editorView(): EditorView | null {
  return puppetProviders.editor?.getView() ?? null;
}

export function selectionOf(view: EditorView): Selection {
  const { from, to } = view.state.selection;
  return { from, to };
}

/** Each snapshot's document: immutable and shared with the editor, so keeping it costs nothing. */
const documentOf = new WeakMap<Snapshot, ProseNode>();

export function takeSnapshot(): Snapshot {
  // A verb that sets component state returns before Svelte applies it to the page: flush
  // first, or the snapshot is of the screen as it was and the receipt says nothing changed.
  flushSync();
  const view = editorView();
  const note = view ? noteLines(view.state.doc) : null;
  const snapshot = push(
    snapshots,
    {
      id: nextSnapshotId++,
      t: now(),
      screen: currentScreen(),
      elements: collectElements({}),
      doc: view && note ? { onScreen: linesOnScreen(view, note) } : null,
      selection: view ? selectionOf(view) : null,
    },
    SNAPSHOT_LIMIT,
  );
  if (view) documentOf.set(snapshot, view.state.doc);
  return snapshot;
}

export function snapshotById(id: number): Snapshot | undefined {
  return snapshots.find((snapshot) => snapshot.id === id);
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clip(text: string): string {
  return text.length > DIFF_TEXT_LIMIT ? `${text.slice(0, DIFF_TEXT_LIMIT)}…` : text;
}

/** One hunk: common prefix and suffix stripped. Enough to read a formatting verb or a keystroke. */
export function diffText(
  before: string,
  after: string,
): { line: number; removed: string; inserted: string } | undefined {
  if (before === after) return undefined;
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start] === after[start]) start++;
  let end = 0;
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end])
    end++;
  return {
    line: before.slice(0, start).split('\n').length,
    removed: clip(before.slice(start, before.length - end)),
    inserted: clip(after.slice(start, after.length - end)),
  };
}

/** Indexes `[from, to)` of the lines a position range touches. */
function lineSpan(note: NoteLines, from: number, to: number): [number, number] {
  const first = note.at(from)?.line ?? 1;
  const last = note.at(to)?.line ?? first;
  return [first - 1, Math.max(first, last)];
}

/** The part of a span of line indexes that `onScreen` shows. */
function shownPart(span: [number, number], onScreen: OnScreen | null): [number, number] | null {
  if (!onScreen) return null;
  const from = Math.max(span[0], onScreen.first - 1);
  const to = Math.min(span[1], onScreen.last);
  return from < to ? [from, to] : null;
}

/**
 * What an action did to the note, as a person looking at it could see: the changed lines that
 * show, as `kind│markdown`, or only where the change is when none of it shows. ProseMirror's
 * own comparison skips the blocks two documents share, so the cost follows the edit.
 */
function diffDocs(before: Snapshot, after: Snapshot): SnapshotDiff['doc'] {
  const docBefore = documentOf.get(before) ?? null;
  const docAfter = documentOf.get(after) ?? null;
  // A note on no screen (the editor kept mounted behind home) changes where nobody looks.
  if (docBefore === docAfter || (!before.doc?.onScreen && !after.doc?.onScreen)) return undefined;
  const noteBefore = docBefore ? noteLines(docBefore) : null;
  const noteAfter = docAfter ? noteLines(docAfter) : null;
  let spanBefore: [number, number] = [0, noteBefore?.count ?? 0];
  let spanAfter: [number, number] = [0, noteAfter?.count ?? 0];
  if (docBefore && docAfter && noteBefore && noteAfter) {
    const start = docBefore.content.findDiffStart(docAfter.content);
    if (start === null) return undefined;
    const end = docBefore.content.findDiffEnd(docAfter.content) ?? { a: start, b: start };
    // An insert or a removal beside a run its edge repeats (a paragraph between two) reports
    // its end before its start: both ends move by the overlap, as ProseMirror's readDOMChange.
    const overlap = Math.max(0, start - Math.min(end.a, end.b));
    spanBefore = lineSpan(noteBefore, start, end.a + overlap);
    spanAfter = lineSpan(noteAfter, start, end.b + overlap);
  }
  const shownBefore = shownPart(spanBefore, before.doc?.onScreen ?? null);
  const shownAfter = shownPart(spanAfter, after.doc?.onScreen ?? null);
  if (!shownBefore && !shownAfter) {
    return {
      line: spanAfter[0] + 1,
      to: Math.max(spanAfter[0] + 1, spanAfter[1]),
      offScreen: true,
    };
  }
  const serialize = (doc: ProseNode) => puppetProviders.editor?.serialize(doc) ?? null;
  // Spans are line indexes from 0, `[from, to)`; a note numbers its lines from 1.
  const listing = (doc: ProseNode | null, note: NoteLines | null, span: [number, number] | null) =>
    doc && note && span ? linesListing(note.slice(span[0] + 1, span[1]), doc, serialize) : '';
  // Both sides from the same line, so the hunk compares one stretch of the change in each
  // version even when the edit scrolled the screen.
  const first = Math.max(shownBefore?.[0] ?? 0, shownAfter?.[0] ?? 0);
  const from = (span: [number, number] | null): [number, number] | null =>
    span && first < span[1] ? [first, span[1]] : null;
  const hunk = diffText(
    listing(docBefore, noteBefore, from(shownBefore)),
    listing(docAfter, noteAfter, from(shownAfter)),
  );
  if (!hunk) return undefined;
  return { ...hunk, line: first + hunk.line };
}

export function diffElements(before: ElementRow[], after: ElementRow[]): SnapshotDiff['elements'] {
  const byRef = new Map(before.map((row) => [row.ref, row]));
  const seen = new Set<string>();
  const added: ElementRow[] = [];
  const changed: ElementChange[] = [];
  for (const row of after) {
    seen.add(row.ref);
    const previous = byRef.get(row.ref);
    if (!previous) {
      added.push(row);
      continue;
    }
    const change: ElementChange = {
      ref: row.ref,
      component: row.component,
      role: row.role,
      text: row.text,
      section: row.section,
    };
    let differs = false;
    if (!sameRect(previous.rect, row.rect)) {
      change.rect = [previous.rect, row.rect];
      differs = true;
    }
    if (!sameJson(previous.flags, row.flags)) {
      change.flags = [previous.flags, row.flags];
      differs = true;
    }
    if (previous.text !== row.text) {
      change.textChange = [previous.text, row.text];
      differs = true;
    }
    if (differs) changed.push(change);
  }
  return { added, removed: before.filter((row) => !seen.has(row.ref)), changed };
}

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const diff: SnapshotDiff = {
    before: before.id,
    after: after.id,
    elements: diffElements(before.elements, after.elements),
  };
  if (before.screen !== after.screen) diff.screen = [before.screen, after.screen];
  const doc = diffDocs(before, after);
  if (doc) diff.doc = doc;
  if (!sameJson(before.selection, after.selection))
    diff.selection = [before.selection, after.selection];
  return diff;
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return (
    !diff.screen &&
    !diff.doc &&
    !diff.selection &&
    diff.elements.added.length + diff.elements.removed.length + diff.elements.changed.length === 0
  );
}

/** Test seam: forget every snapshot (puppetTrace.ts `resetTrace`). */
export function resetSnapshots(): void {
  snapshots.length = 0;
}
