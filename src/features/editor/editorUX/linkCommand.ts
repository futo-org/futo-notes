import { EditorView } from '@codemirror/view';

export function toggleCodeInline(view: EditorView): void {
  const { state } = view;
  const { from, to } = state.selection.main;

  if (from === to) {
    const afterText = state.sliceDoc(from, from + 1);
    const beforeText = state.sliceDoc(Math.max(0, from - 1), from);
    if (afterText === '`' && beforeText === '`') {
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

  const insert = '[]()';
  view.dispatch({
    changes: { from, insert },
    selection: { anchor: from + 1 },
  });
  view.focus();
}
