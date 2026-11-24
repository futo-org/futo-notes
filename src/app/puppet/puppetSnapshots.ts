/**
 * Snapshots: the derived state an action is judged by — the interactable elements, the open
 * note as far as it shows, the selection — taken before and after every action, and the diff
 * between two. Ring-buffered alongside the trace (puppetTrace.ts).
 */
import { flushSync } from 'svelte';

import { collectElements, type ElementRow, type Rect } from './puppetElements';
import { currentScreen } from './puppetRegistry';
import type { OnScreen } from './puppetText';
import { textEditorSnapshot, textSourceDiff } from './puppetTextSnapshots';

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
  /** The desktop editor's note source (puppetTextSnapshots.ts); its text is the diff's. */
  source?: string | null;
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

export function takeSnapshot(): Snapshot {
  // A verb that sets component state returns before Svelte applies it to the page: flush
  // first, or the snapshot is of the screen as it was and the receipt says nothing changed.
  flushSync();
  return push(
    snapshots,
    {
      id: nextSnapshotId++,
      t: now(),
      screen: currentScreen(),
      elements: collectElements({}),
      ...textEditorSnapshot(),
    },
    SNAPSHOT_LIMIT,
  );
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
  const doc = textSourceDiff(before, after);
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
