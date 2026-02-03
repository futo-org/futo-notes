import { StateField, StateEffect, EditorState, RangeSet } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
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

// Effect to trigger table decoration rebuild when syntax tree grows
const rebuildTablesEffect = StateEffect.define<null>();

/**
 * StateField that renders tables as HTML widgets when cursor is outside.
 * Must be StateField (not ViewPlugin) because block replacements require
 * decorations to be computed before viewport calculation.
 */
const tableRenderingField = StateField.define<DecorationSet>({
  create(state): DecorationSet {
    return buildTableDecorations(state);
  },

  update(decorations, tr): DecorationSet {
    if (tr.docChanged || tr.selection || tr.effects.some(e => e.is(rebuildTablesEffect))) {
      return buildTableDecorations(tr.state);
    }
    return decorations;
  },

  provide(field) {
    return EditorView.decorations.from(field);
  }
});

/**
 * ViewPlugin that watches for syntax tree growth and triggers rebuilds.
 */
const tableTreeWatcher = ViewPlugin.define(view => {
  let lastTreeLength = syntaxTree(view.state).length;

  return {
    update(update: ViewUpdate) {
      const tree = syntaxTree(update.state);
      if (tree.length > lastTreeLength) {
        lastTreeLength = tree.length;
        // Use setTimeout to avoid dispatch during update
        setTimeout(() => {
          update.view.dispatch({ effects: rebuildTablesEffect.of(null) });
        }, 0);
      }
    }
  };
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

// Export both extensions
export const tableRendering = [tableRenderingField, tableTreeWatcher];
