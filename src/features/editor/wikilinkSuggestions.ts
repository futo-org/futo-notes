/**
 * What `[[` autocomplete offers.
 *
 * docs/spec/editor.md specifies this once — "Typing `[[` opens autocomplete
 * over all note ids; selecting inserts the full path" — so it is implemented
 * once here and consumed by the Milkdown plugin
 * (`milkdown/wikilink/autocomplete.ts`). It sat one level up from that plugin
 * because a second consumer, the CodeMirror completion source, used to read it
 * too; that engine is gone, but the split still keeps "which notes come back,
 * in which order, labelled how" testable apart from the insertion mechanics.
 *
 * Resolution and shortest-unique-suffix are NOT decided here — they come from
 * the conformance-locked `$shared/note/wikilinks` index that the Rust rename
 * rewriter mirrors.
 */
import type { NotePreview } from '$shared/types/note';
import type { WikilinkIndex } from '$shared/note/wikilinks';

/** How many notes the popup offers at once. */
export const WIKILINK_SUGGESTION_LIMIT = 20;

/**
 * An open `[[` with no closer yet, anchored to the caret. Stops at `]` so a
 * COMPLETED link earlier on the line cannot re-open the popup — in
 * `[[a]] and [[`, only the second `[[` is open.
 *
 * Deliberately looser than `WIKILINK_RE`: this matches a link being typed, not
 * a finished one, so it has no closing `]]` to anchor on.
 */
export const OPEN_WIKILINK_RE = /\[\[([^\]]*)$/;

export interface WikilinkQuery {
  /** Offset of the `[` that opened it, within the text that was searched. */
  from: number;
  /** Everything typed after `[[`. */
  query: string;
}

export function wikilinkQueryIn(textBefore: string): WikilinkQuery | null {
  const match = OPEN_WIKILINK_RE.exec(textBefore);
  if (!match) return null;
  return { from: textBefore.length - match[0].length, query: match[1] };
}

export interface WikilinkCandidate {
  /** The note id inserted as the link target — always the FULL path. */
  id: string;
  /** The row's headline: the shortest unique suffix. */
  label: string;
  /** The full id, when the label alone does not show it. */
  detail?: string;
}

export function wikilinkCandidates(
  query: string,
  notes: readonly NotePreview[],
  index: WikilinkIndex,
  limit: number = WIKILINK_SUGGESTION_LIMIT,
): WikilinkCandidate[] {
  const trimmed = query.trim();
  const matched = trimmed
    ? notes.filter((note) => note.id.toLocaleLowerCase().includes(trimmed.toLocaleLowerCase()))
    : notes;
  return matched.slice(0, limit).map((note) => {
    const label = index.displaySuffix(note.id);
    return label === note.id ? { id: note.id, label } : { id: note.id, label, detail: note.id };
  });
}
