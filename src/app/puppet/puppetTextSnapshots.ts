/* The desktop editor's part of a snapshot (puppetSnapshots.ts): which lines show, the engine's
 * selection and the note's source, and the receipt's `doc` hunk between two of them, in the
 * saved markdown, on the line it starts. The source is read once per engine revision, so a
 * large note costs one copy per edit, not two per action. */
import type { Engine } from '$features/editor/desktop/engine';
import { diffText, type Snapshot, type SnapshotDiff } from './puppetSnapshots';
import { puppetProviders } from './puppetRegistry';
import { textLinesOnScreen } from './puppetTextLines';

let cached: { engine: Engine; revision: number; source: string } | null = null;

function sourceOf(engine: Engine): string {
  if (cached?.engine === engine && cached.revision === engine.revision) return cached.source;
  cached = { engine, revision: engine.revision, source: engine.draftText() };
  return cached.source;
}

export function textEditorSnapshot(): Pick<Snapshot, 'doc' | 'selection' | 'source'> {
  const view = puppetProviders.textEditor?.view();
  const engine = view?.currentEngine();
  if (!view || !engine) return { doc: null, selection: null, source: null };
  const range = view.selection.range();
  return {
    doc: { onScreen: textLinesOnScreen(view) },
    selection: range && { from: range.start, to: range.end },
    source: sourceOf(engine),
  };
}

/** Whether lines `first`..`last` (1-based) cross what a snapshot showed. */
function shows(snapshot: Snapshot, first: number, last: number): boolean {
  const onScreen = snapshot.doc?.onScreen;
  return !!onScreen && first <= onScreen.last && last >= onScreen.first;
}

/** What an action did to the note: the hunk between the sources either side, or only where it
 *  is when none of it showed before or after. Another note is a new screen, not an edit. */
export function textSourceDiff(before: Snapshot, after: Snapshot): SnapshotDiff['doc'] {
  if (
    before.screen !== after.screen ||
    typeof before.source !== 'string' ||
    typeof after.source !== 'string'
  ) {
    return undefined;
  }
  const hunk = diffText(before.source, after.source);
  if (!hunk) return undefined;
  const last = (text: string) => hunk.line + text.split('\n').length - 1;
  const lastLine = Math.max(last(hunk.removed), last(hunk.inserted));
  if (shows(before, hunk.line, lastLine) || shows(after, hunk.line, lastLine)) return hunk;
  return { line: hunk.line, to: lastLine, offScreen: true };
}
