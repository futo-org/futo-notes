/*
 * Find-in-note matching over a ProseMirror document.
 *
 * Ported from the CodeMirror editor's `src/features/editor/find/findMatches.ts`
 * (commit 8e902802, issue #26). The arithmetic — which match is "current", how
 * stepping wraps, how the count is worded — is unchanged and engine-neutral.
 * What had to be rewritten is the scan itself: CodeMirror searched a flat
 * `Text` with `@codemirror/search`'s `SearchCursor`, and a ProseMirror document
 * is a tree whose text lives in many nodes at many positions.
 *
 * The scan is a run-based one. `docTextSegments` walks the document once and
 * collects every MAXIMAL run of adjacent text — adjacent in ProseMirror
 * positions, so two text nodes split only by a mark (`**bo**ld`) join into one
 * run and a query spanning the mark boundary still matches, while a block
 * boundary or an inline leaf (an image, a hard break) ends the run. A match can
 * therefore never straddle two paragraphs, and offset `i` inside a run at
 * `from` is always document position `from + i`.
 *
 * > Gap against docs/spec/editor.md: CodeMirror searched the SOURCE markdown,
 * > so `**` and a link's URL were findable. Milkdown is WYSIWYG and holds no
 * > syntax characters in its document, so find matches the text the reader
 * > sees. Recorded under the spec's "Find in note" section.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

import { localizedText } from '$shared/localization';

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindMatchReport {
  query: string;
  current: number;
  total: number;
  label: string;
}

/** A maximal run of adjacent text, and the document position of its first character. */
export interface TextSegment {
  from: number;
  text: string;
}

/**
 * `text` lowercased WITHOUT changing its length.
 *
 * A handful of code points grow when lowercased (`İ` → `i̇`, two code units),
 * and a naive `toLowerCase()` of the haystack would shift every offset after
 * one of them — reporting matches at the wrong document positions. Growing
 * characters are therefore left as they are: they simply do not case-fold,
 * which can only ever lose a case-insensitive match, never invent one at a
 * wrong place.
 */
export function foldCase(text: string): string {
  const folded = text.toLowerCase();
  if (folded.length === text.length) return folded;
  let out = '';
  for (const character of text) {
    const lower = character.toLowerCase();
    out += lower.length === character.length ? lower : character;
  }
  return out;
}

/**
 * Every run of adjacent text in `doc`, in document order.
 *
 * Runs are joined on position adjacency alone: a run that ends at position `p`
 * absorbs a text node that starts at `p`. Nothing else has to know which node
 * types break a run, because every non-text node occupies at least one position
 * and so breaks adjacency by itself.
 */
export function docTextSegments(doc: ProseNode): TextSegment[] {
  const segments: TextSegment[] = [];
  let open: TextSegment | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const text = node.text ?? '';
    if (open && open.from + open.text.length === pos) open.text += text;
    else {
      open = { from: pos, text };
      segments.push(open);
    }
    return false;
  });
  return segments;
}

/**
 * Every case-insensitive literal occurrence of `query` in `doc`, ascending.
 *
 * Literal means exactly that (docs/spec/editor.md): no fuzzy matching, no
 * prefix rule, no regex — `cat` finds `concatenate`. Overlapping occurrences
 * are not reported twice; the scan resumes after each hit.
 */
export function findDocMatches(doc: ProseNode, query: string): FindMatch[] {
  if (!query) return [];
  return findSegmentMatches(docTextSegments(doc), query);
}

export function findSegmentMatches(segments: readonly TextSegment[], query: string): FindMatch[] {
  if (!query) return [];
  const needle = foldCase(query);
  const width = query.length;
  const matches: FindMatch[] = [];
  for (const segment of segments) {
    const haystack = foldCase(segment.text);
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      matches.push({ from: segment.from + at, to: segment.from + at + width });
      at = haystack.indexOf(needle, at + Math.max(1, needle.length));
    }
  }
  return matches;
}

/**
 * The match the given selection is "at" — the one it exactly covers, else the
 * first one at or after it, else the first match (a selection past the last
 * occurrence wraps to the top).
 *
 * Unchanged from the CodeMirror engine.
 */
export function findCurrentMatchIndex(
  matches: readonly FindMatch[],
  selection: { from: number; to: number },
): number {
  if (matches.length === 0) return -1;
  const exact = matches.findIndex(
    (match) => match.from === selection.from && match.to === selection.to,
  );
  if (exact >= 0) return exact;
  const next = matches.findIndex((match) => match.from >= selection.from);
  return next >= 0 ? next : 0;
}

/** `index` wrapped into `[0, length)`, in both directions. */
export function wrapFindMatchIndex(index: number, length: number): number {
  if (length === 0) return -1;
  return ((index % length) + length) % length;
}

/**
 * The `{query, current, total, label}` report every platform renders verbatim.
 *
 * The label is the engine's, not the bar's — the native bars must never do
 * count arithmetic or word a count themselves (docs/spec/editor.md). It comes
 * from the catalog (`editor.find.matchCount`), so a translation changes it in
 * all three bars at once.
 */
export function createFindMatchReport(
  query: string,
  currentIndex: number,
  total: number,
): FindMatchReport {
  const current = total === 0 ? 0 : currentIndex + 1;
  return {
    query,
    current,
    total,
    label: localizedText('editor.find.matchCount', { current, total }),
  };
}
