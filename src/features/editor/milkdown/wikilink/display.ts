/**
 * How a `[[target]]` renders: the text on screen, and whether it is broken.
 *
 * The rules themselves are NOT here — resolution and shortest-unique-suffix
 * come from the conformance-locked `$shared/note/wikilinks` index that the CM6
 * decorations, the Rust store and the rename rewriter all share. This module
 * only says which of its two answers a rendered link uses, so the Milkdown node
 * view and its tests agree with `live-preview/wikilinkDecorations.ts`.
 */
import type { WikilinkIndex } from '$shared/note/wikilinks';

/** Marks the anchor as a link the pointer handlers should follow. */
export const WIKILINK_CLASS = 'cm-md-link cm-md-wikilink';
/**
 * Added when the target resolves to nothing — absent OR ambiguous, which
 * `resolveWikilink` deliberately treats the same. Shared with the CodeMirror
 * editor so one stylesheet rule (`markdown-links.css`) covers both engines and
 * the "muted, identifiable before you tap it" spec line has a single owner.
 */
export const WIKILINK_BROKEN_CLASS = 'cm-md-wikilink-broken';

export interface WikilinkDisplay {
  /** What the reader sees: the shortest unique suffix, or the raw target. */
  text: string;
  /** The note id this points at, or null when the link is broken. */
  resolvedId: string | null;
  className: string;
}

export function wikilinkDisplay(target: string, index: WikilinkIndex): WikilinkDisplay {
  const resolvedId = index.resolve(target);
  return {
    // A broken link shows its raw target — that text is also the title the
    // create-on-missing path binds the new note to (docs/spec/editor.md).
    text: resolvedId === null ? target : index.displaySuffix(resolvedId),
    resolvedId,
    className: resolvedId === null ? `${WIKILINK_CLASS} ${WIKILINK_BROKEN_CLASS}` : WIKILINK_CLASS,
  };
}
