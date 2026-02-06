import { StateField, RangeSet, EditorState } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { TableWidget } from './tableWidget';

/**
 * Checks if the cursor is inside the given range (inclusive)
 */
function isCursorInRange(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) {
      return true;
    }
  }
  return false;
}

interface TableFieldValue {
  decorations: DecorationSet;
  treeLength: number;
}

/** StateField — block replacements must be computed before viewport calculation. */
const tableRenderingField = StateField.define<TableFieldValue>({
  create(state): TableFieldValue {
    // Force full parse so table decorations are present from the start
    ensureSyntaxTree(state, state.doc.length, 5000);
    const tree = syntaxTree(state);
    return {
      decorations: buildTableDecorations(state),
      treeLength: tree.length
    };
  },

  update(value, tr): TableFieldValue {
    const tree = syntaxTree(tr.state);
    const treeGrew = tree.length > value.treeLength;

    if (tr.docChanged || tr.selection || treeGrew) {
      return {
        decorations: buildTableDecorations(tr.state),
        treeLength: tree.length
      };
    }
    return value;
  },

  provide(field) {
    return EditorView.decorations.from(field, v => v.decorations);
  }
});

function buildTableDecorations(state: EditorState): DecorationSet {
  const decorations: Array<{ from: number; to: number; decoration: Decoration }> = [];
  const tree = syntaxTree(state);
  const doc = state.doc;

  tree.iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        const from = node.from;
        const to = node.to;

        if (isCursorInRange(state, from, to)) {
          return;
        }

        const text = doc.sliceString(from, to);
        const widget = new TableWidget(text, from, to);
        const decoration = Decoration.replace({
          widget,
          block: true
        });

        decorations.push({ from, to, decoration });
      }
    }
  });

  decorations.sort((a, b) => a.from - b.from);

  return RangeSet.of(
    decorations.map(d => d.decoration.range(d.from, d.to))
  );
}

export const tableRendering = tableRenderingField;
