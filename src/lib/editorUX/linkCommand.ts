import { EditorView } from '@codemirror/view';

/**
 * Inline-code toggle: wrap selection in backticks, or unwrap if already wrapped.
 * Mirrors the toggle semantics of `toggleBold` / `toggleItalic` in markdownToolbar.ts.
 */
export function toggleCodeInline(view: EditorView): void {
  const { state } = view;
  const { from, to } = state.selection.main;

  if (from === to) {
    // Empty selection — if we're inside `` `` insert nothing, else insert an empty pair
    const afterText = state.sliceDoc(from, from + 1);
    const beforeText = state.sliceDoc(Math.max(0, from - 1), from);
    if (afterText === '`' && beforeText === '`') {
      // already empty pair — just advance past closing tick
      view.dispatch({ selection: { anchor: from + 1 } });
    } else {
      view.dispatch({
        changes: { from, insert: '``' },
        selection: { anchor: from + 1 },
      });
    }
    view.focus();
    return;
  }

  const selected = state.sliceDoc(from, to);
  // If selection already wrapped in single backticks — unwrap
  if (
    selected.length >= 2 &&
    selected.startsWith('`') &&
    selected.endsWith('`') &&
    !selected.slice(1, -1).includes('`')
  ) {
    const inner = selected.slice(1, -1);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    view.focus();
    return;
  }

  // Check for surrounding backticks just outside selection
  const before = state.sliceDoc(Math.max(0, from - 1), from);
  const after = state.sliceDoc(to, Math.min(state.doc.length, to + 1));
  if (before === '`' && after === '`') {
    view.dispatch({
      changes: [
        { from: from - 1, to: from, insert: '' },
        { from: to, to: to + 1, insert: '' },
      ],
      selection: { anchor: from - 1, head: to - 1 },
    });
    view.focus();
    return;
  }

  // Wrap selection
  view.dispatch({
    changes: [
      { from, insert: '`' },
      { from: to, insert: '`' },
    ],
    selection: { anchor: from + 1, head: to + 1 },
  });
  view.focus();
}

const MD_LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/;

/**
 * Wrap selection in `[text](url)`. If selection is already a markdown link, unwrap it
 * back to the link text. If no selection, insert an empty link scaffold with the cursor
 * inside the URL slot.
 *
 * `getUrl` is called when we need a URL from the user — in tests we inject a mock.
 * In the editor we default to `window.prompt`, which mirrors how our existing commands
 * handle user input (no modal infra yet).
 */
export function toggleLink(
  view: EditorView,
  getUrl: (current: string) => string | null = (current) => window.prompt('Link URL', current),
): void {
  const { state } = view;
  const { from, to } = state.selection.main;

  if (from !== to) {
    const selected = state.sliceDoc(from, to);
    const m = selected.match(MD_LINK_RE);
    if (m) {
      // Already a link — unwrap to link text
      const text = m[1];
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from, head: from + text.length },
      });
      view.focus();
      return;
    }

    const url = getUrl('');
    if (url === null) return;
    const insert = `[${selected}](${url})`;
    view.dispatch({
      changes: { from, to, insert },
      selection: {
        anchor: from + 1 + selected.length + 2,
        head: from + insert.length - 1,
      },
    });
    view.focus();
    return;
  }

  // No selection — insert empty scaffold, place cursor between brackets
  const insert = '[]()';
  view.dispatch({
    changes: { from, insert },
    selection: { anchor: from + 1 },
  });
  view.focus();
}
