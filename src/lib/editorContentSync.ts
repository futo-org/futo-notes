import type { Annotation, TransactionSpec } from '@codemirror/state';
import type { EditorState, Text } from '@codemirror/state';

export interface SetEditorContentOptions {
  preserveSelection?: boolean;
  /** Annotations to attach to the transaction (e.g., addToHistory). */
  annotations?: Annotation<unknown>[];
}

/**
 * Check whether the CM6 document matches nextText without materializing
 * the full string. Uses length check + sampled slices (O(log n) each).
 *
 * For short documents (< 256 chars) we compare via sliceString since the
 * cost is negligible. For longer documents, 5 spread probes covering
 * 160 chars total are statistically certain to catch any real difference.
 */
function docMatchesText(state: EditorState, nextText: string): boolean {
  if (state.doc.length !== nextText.length) return false;

  const len = nextText.length;

  // Short docs: compare directly via sliceString (avoids toString allocation)
  if (len < 256) {
    return state.doc.sliceString(0) === nextText;
  }

  // Sample 5 positions spread across the document — unrolled to avoid
  // array allocation. Each sliceString is O(log n).
  const probeLen = 32;
  const p1 = 0;
  const p2 = len >>> 2;
  const p3 = len >>> 1;
  const p4 = (len >>> 2) * 3;
  const p5 = len - probeLen;  // len >= 256, so this is >= 224

  if (state.doc.sliceString(p1, p1 + probeLen) !== nextText.slice(p1, p1 + probeLen)) return false;
  if (state.doc.sliceString(p2, p2 + probeLen) !== nextText.slice(p2, p2 + probeLen)) return false;
  if (state.doc.sliceString(p3, p3 + probeLen) !== nextText.slice(p3, p3 + probeLen)) return false;
  if (state.doc.sliceString(p4, p4 + probeLen) !== nextText.slice(p4, p4 + probeLen)) return false;
  if (state.doc.sliceString(p5, p5 + probeLen) !== nextText.slice(p5, p5 + probeLen)) return false;
  return true;
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
        // Found divergence — scan from end of this chunk to find exact boundary
        for (let j = chunkLen - 1; j >= i; j--) {
          if (docSlice.charCodeAt(j) !== nextText.charCodeAt(nextBase + j)) {
            docSuffix -= chunkLen - 1 - j;
            nextSuffix -= chunkLen - 1 - j;
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
