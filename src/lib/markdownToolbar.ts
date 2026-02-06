import { EditorView } from '@codemirror/view';

interface MarkdownSyntax {
  prefix: string;
  suffix: string;
}

const BOLD: MarkdownSyntax = { prefix: '**', suffix: '**' };
const ITALIC: MarkdownSyntax = { prefix: '*', suffix: '*' };
const STRIKETHROUGH: MarkdownSyntax = { prefix: '~~', suffix: '~~' };

function toggleSyntax(view: EditorView, { prefix, suffix }: MarkdownSyntax): void {
  const { state } = view;
  const { from, to } = state.selection.main;

  if (from === to) {
    // No selection - check if we're inside markers for this syntax
    const afterText = state.sliceDoc(from, from + suffix.length);

    if (afterText === suffix) {
      const beforeText = state.sliceDoc(Math.max(0, from - prefix.length), from);

      if (beforeText === prefix) {
        // Empty markers (e.g. **|**) — remove them
        view.dispatch({
          changes: { from: from - prefix.length, to: from + suffix.length, insert: '' },
          selection: { anchor: from - prefix.length }
        });
      } else {
        // Has content (e.g. **word|**) — jump past closing markers
        view.dispatch({
          selection: { anchor: from + suffix.length }
        });
      }
      view.focus();
      return;
    }

    // Not inside markers — insert new pair with cursor in middle
    view.dispatch({
      changes: { from, insert: prefix + suffix },
      selection: { anchor: from + prefix.length }
    });
    view.focus();
    return;
  }

  // Has selection - check if markers surround it
  const prefixStart = Math.max(0, from - prefix.length);
  const suffixEnd = Math.min(state.doc.length, to + suffix.length);
  const before = state.sliceDoc(prefixStart, from);
  const after = state.sliceDoc(to, suffixEnd);

  if (before === prefix && after === suffix) {
    // Already wrapped - remove surrounding markers
    view.dispatch({
      changes: [
        { from: prefixStart, to: from, insert: '' },
        { from: to, to: suffixEnd, insert: '' }
      ],
      selection: { anchor: prefixStart, head: prefixStart + (to - from) }
    });
  } else {
    // Wrap selection with markers
    view.dispatch({
      changes: [
        { from, insert: prefix },
        { from: to, insert: suffix }
      ],
      selection: { anchor: from + prefix.length, head: to + prefix.length }
    });
  }

  view.focus();
}

export function toggleBold(view: EditorView): void {
  toggleSyntax(view, BOLD);
}

export function toggleItalic(view: EditorView): void {
  toggleSyntax(view, ITALIC);
}

export function toggleStrikethrough(view: EditorView): void {
  toggleSyntax(view, STRIKETHROUGH);
}
