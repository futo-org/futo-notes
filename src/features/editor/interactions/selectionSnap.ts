import { syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** Expands a desktop selection through hidden markdown markers after its pointer gesture settles. */
export function snapSelectionPastMarkdownMarkers(view: EditorView, wasDragging: boolean): void {
  const selection = view.state.selection.main;
  if (selection.empty) return;

  const forward = selection.anchor <= selection.head;
  const originalFrom = forward ? selection.anchor : selection.head;
  const originalTo = forward ? selection.head : selection.anchor;
  const doc = view.state.doc;
  let from = originalFrom;
  let to = originalTo;

  syntaxTree(view.state).iterate({
    enter: (node) => {
      if (node.to < originalFrom || node.from > originalTo) return;

      if (/^ATXHeading[1-6]$/.test(node.name)) {
        if (!wasDragging) return;
        const headingStart = doc.sliceString(node.from, Math.min(node.to, node.from + 8));
        const marker = headingStart.match(/^#+ ?/)?.[0] ?? '';
        if (marker && originalFrom === node.from + marker.length && originalTo > originalFrom) {
          from = Math.min(from, node.from);
        }
        return;
      }

      let markerLength = 0;
      if (node.name === 'StrongEmphasis' || node.name === 'Strikethrough') markerLength = 2;
      else if (node.name === 'Emphasis') markerLength = 1;
      else if (node.name === 'InlineCode') {
        const codeStart = doc.sliceString(node.from, Math.min(node.to, node.from + 10));
        markerLength = codeStart.match(/^`+/)?.[0].length ?? 0;
      } else return;

      const innerFrom = node.from + markerLength;
      const innerTo = node.to - markerLength;
      if (markerLength === 0 || innerFrom >= innerTo) return;
      if (originalFrom > innerFrom || originalTo < innerTo) return;

      if (originalFrom <= node.from && originalTo === innerTo) to = Math.max(to, node.to);
      if (originalTo >= node.to && originalFrom === innerFrom) from = Math.min(from, node.from);
      if (wasDragging && originalFrom === innerFrom && originalTo === innerTo) {
        from = Math.min(from, node.from);
        to = Math.max(to, node.to);
      }
    },
  });

  if (from === originalFrom && to === originalTo) return;
  view.dispatch({
    selection: EditorSelection.single(forward ? from : to, forward ? to : from),
  });
}
