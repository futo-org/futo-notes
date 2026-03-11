import type { TransactionSpec } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';

export interface SetEditorContentOptions {
  preserveSelection?: boolean;
}

export function buildSetContentTransaction(
  state: EditorState,
  nextText: string,
  options: SetEditorContentOptions = {},
): TransactionSpec | null {
  const currentText = state.doc.toString();
  if (currentText === nextText) return null;

  if (options.preserveSelection) {
    const { from, to, insert } = getMinimalTextChange(currentText, nextText);
    return {
      changes: {
        from,
        to,
        insert,
      },
    };
  }

  return {
    changes: {
      from: 0,
      to: state.doc.length,
      insert: nextText,
    },
  };
}

function getMinimalTextChange(currentText: string, nextText: string): {
  from: number;
  to: number;
  insert: string;
} {
  const sharedLength = Math.min(currentText.length, nextText.length);

  let prefix = 0;
  while (prefix < sharedLength && currentText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) {
    prefix++;
  }

  let currentSuffix = currentText.length;
  let nextSuffix = nextText.length;
  while (
    currentSuffix > prefix &&
    nextSuffix > prefix &&
    currentText.charCodeAt(currentSuffix - 1) === nextText.charCodeAt(nextSuffix - 1)
  ) {
    currentSuffix--;
    nextSuffix--;
  }

  return {
    from: prefix,
    to: currentSuffix,
    insert: nextText.slice(prefix, nextSuffix),
  };
}
