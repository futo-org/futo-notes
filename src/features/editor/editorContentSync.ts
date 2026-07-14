import type { Annotation, TransactionSpec } from '@codemirror/state';
import type { EditorState, Text } from '@codemirror/state';

export interface SetEditorContentOptions {
  preserveSelection?: boolean;
  annotations?: Annotation<unknown>[];
}

// `undefined` means there is no live editor and the save must be skipped;
// `''` is real user content. Collapsing the two once allowed a torn-down
// editor to overwrite a note with an empty body and sync that truncation.
export function readDocContent(view: { state: EditorState } | null): string | undefined {
  return view ? view.state.doc.toString() : undefined;
}

function docMatchesText(state: EditorState, nextText: string): boolean {
  if (state.doc.length !== nextText.length) return false;
  return state.doc.sliceString(0) === nextText;
}

export interface SetContentResult {
  spec: TransactionSpec;
  insertedText: string;
}

export function buildSetContentTransaction(
  state: EditorState,
  nextText: string,
  options: SetEditorContentOptions = {},
): SetContentResult | null {
  if (docMatchesText(state, nextText)) return null;

  const annotations = options.annotations;

  if (options.preserveSelection) {
    const change = getMinimalChangeFromDoc(state.doc, nextText);
    const spec: TransactionSpec = { changes: change };
    if (annotations) spec.annotations = annotations;
    return { spec, insertedText: change.insert };
  }
  const spec: TransactionSpec = { changes: { from: 0, to: state.doc.length, insert: nextText } };
  if (annotations) spec.annotations = annotations;
  return { spec, insertedText: nextText };
}

function getMinimalChangeFromDoc(
  doc: Text,
  nextText: string,
): { from: number; to: number; insert: string } {
  const sharedLen = Math.min(doc.length, nextText.length);

  let prefix = 0;
  const iter = doc.iter();
  outer: while (!iter.done && prefix < sharedLen) {
    const leaf = iter.value;
    const compareEnd = Math.min(prefix + leaf.length, sharedLen);
    const compareLen = compareEnd - prefix;

    for (let i = 0; i < compareLen; i++) {
      if (leaf.charCodeAt(i) !== nextText.charCodeAt(prefix + i)) {
        prefix += i;
        break outer;
      }
    }

    prefix = compareEnd;
    iter.next();
  }

  let docSuffix = doc.length;
  let nextSuffix = nextText.length;
  const CHUNK = 64;

  while (docSuffix > prefix && nextSuffix > prefix) {
    const chunkLen = Math.min(CHUNK, docSuffix - prefix, nextSuffix - prefix);
    const docSlice = doc.sliceString(docSuffix - chunkLen, docSuffix);
    const nextBase = nextSuffix - chunkLen;

    let chunkMatch = true;
    for (let i = 0; i < chunkLen; i++) {
      if (docSlice.charCodeAt(i) !== nextText.charCodeAt(nextBase + i)) {
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
