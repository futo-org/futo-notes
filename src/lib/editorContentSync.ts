import type { Annotation, TransactionSpec } from '@codemirror/state';
import type { EditorState, Text } from '@codemirror/state';

export interface SetEditorContentOptions {
  preserveSelection?: boolean;
  /** Annotations to attach to the transaction (e.g., addToHistory). */
  annotations?: Annotation<unknown>[];
}

/**
 * Read the editor document, or `undefined` when there is no live view.
 *
 * The distinction is load-bearing: the save pipeline persists whatever
 * `getEditorContent()` returns, so a destroyed/not-yet-mounted view that
 * reads as `''` is indistinguishable from "the user deleted everything".
 * A stale flushSave firing against a torn-down editor (observed 2026-06-04
 * via a dev HMR swap) saved '' over the open note and sync propagated the
 * truncation to every device. Callers must treat `undefined` as "no
 * editor" and skip the save — never coalesce it to ''.
 */
export function readDocContent(view: { state: EditorState } | null): string | undefined {
  return view ? view.state.doc.toString() : undefined;
}

/** Check whether the CM6 document exactly matches nextText. */
function docMatchesText(state: EditorState, nextText: string): boolean {
  if (state.doc.length !== nextText.length) return false;
  return state.doc.sliceString(0) === nextText;
}

export interface SetContentResult {
  spec: TransactionSpec;
  /** The text that was inserted. For incremental updates this is just the
   *  changed region; for full replacements it equals the full nextText. */
  insertedText: string;
}

export function buildSetContentTransaction(
  state: EditorState,
  nextText: string,
  options: SetEditorContentOptions = {},
): SetContentResult | null {
  // Fast path: no change detected — avoids toString() entirely
  if (docMatchesText(state, nextText)) return null;

  const annotations = options.annotations;

  if (options.preserveSelection) {
    // Diff directly against the rope tree — no toString() allocation
    const change = getMinimalChangeFromDoc(state.doc, nextText);
    const spec: TransactionSpec = { changes: change };
    if (annotations) spec.annotations = annotations;
    return { spec, insertedText: change.insert };
  }
  const spec: TransactionSpec = { changes: { from: 0, to: state.doc.length, insert: nextText } };
  if (annotations) spec.annotations = annotations;
  return { spec, insertedText: nextText };
}

/**
 * Find the minimal {from, to, insert} change between a CM6 Text (rope)
 * and a plain string, without materializing the full document string.
 *
 * Prefix: iterates rope leaf nodes forward, comparing each leaf against
 * nextText via charCodeAt — zero string allocations (rope leaves already
 * exist, nextText is the input parameter).
 *
 * Suffix: scans backward comparing doc slices against nextText via
 * charCodeAt. Only the doc.sliceString allocates; the nextText side
 * is index-accessed directly.
 */
function getMinimalChangeFromDoc(
  doc: Text,
  nextText: string,
): { from: number; to: number; insert: string } {
  const sharedLen = Math.min(doc.length, nextText.length);

  // ── Find prefix divergence by iterating rope leaves ──
  // Uses charCodeAt to avoid nextText.slice() allocations per leaf.
  let prefix = 0;
  const iter = doc.iter();
  outer: while (!iter.done && prefix < sharedLen) {
    const leaf = iter.value;
    const compareEnd = Math.min(prefix + leaf.length, sharedLen);
    const compareLen = compareEnd - prefix;

    // Compare leaf chars against nextText directly — no slice allocation
    for (let i = 0; i < compareLen; i++) {
      if (leaf.charCodeAt(i) !== nextText.charCodeAt(prefix + i)) {
        prefix += i;
        break outer;
      }
    }

    // Entire leaf matched — advance to next
    prefix = compareEnd;
    iter.next();
  }

  // ── Find suffix divergence ──
  // Compare backward using doc.sliceString chunks + charCodeAt against
  // nextText (no nextText.slice allocation needed).
  let docSuffix = doc.length;
  let nextSuffix = nextText.length;
  const CHUNK = 64;

  while (docSuffix > prefix && nextSuffix > prefix) {
    const chunkLen = Math.min(CHUNK, docSuffix - prefix, nextSuffix - prefix);
    const docSlice = doc.sliceString(docSuffix - chunkLen, docSuffix);
    const nextBase = nextSuffix - chunkLen;

    // Compare chunk via charCodeAt — avoids nextText.slice() allocation
    let chunkMatch = true;
    for (let i = 0; i < chunkLen; i++) {
      if (docSlice.charCodeAt(i) !== nextText.charCodeAt(nextBase + i)) {
        // Found divergence — scan from end of this chunk to find exact boundary.
        // Each matching iteration decrements docSuffix/nextSuffix to consume
        // the shared suffix character. On mismatch, just break — the cursors
        // are already positioned correctly after the last match.
        for (let j = chunkLen - 1; j >= i; j--) {
          if (docSlice.charCodeAt(j) !== nextText.charCodeAt(nextBase + j)) {
            break;
          }
          docSuffix--;
          nextSuffix--;
        }
        chunkMatch = false;
        break;
      }
    }

    if (chunkMatch) {
      docSuffix -= chunkLen;
      nextSuffix -= chunkLen;
    } else {
      break;
    }
  }

  return {
    from: prefix,
    to: docSuffix,
    insert: nextText.slice(prefix, nextSuffix),
  };
}
