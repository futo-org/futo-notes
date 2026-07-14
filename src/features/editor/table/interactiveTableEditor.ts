import { syntaxTree } from '@codemirror/language';
import { RangeSet, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import {
  isMarkdownSelectionRevealSuppressed,
  liveMarkdownRefresh,
  selectionTouchesRange,
} from '../liveMarkdownTransform';
import { TableEditorWidget } from './tableEditorWidget';

interface TableEditorFieldValue {
  decorations: DecorationSet;
  treeLength: number;
  hasFocus: boolean;
}

const setTableFocus = StateEffect.define<boolean>();

function buildTableDecorations(state: EditorState, hasFocus: boolean): DecorationSet {
  const decorations: Array<{ from: number; to: number; decoration: Decoration }> = [];
  const tree = syntaxTree(state);

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return;
      if (selectionTouchesRange(hasFocus, state.selection.ranges, node.from, node.to)) return;

      const source = state.doc.sliceString(node.from, node.to);
      decorations.push({
        from: node.from,
        to: node.to,
        decoration: Decoration.replace({
          widget: new TableEditorWidget(source, node.from, node.to),
          block: true,
        }),
      });
    },
  });

  decorations.sort((left, right) => left.from - right.from);
  return RangeSet.of(decorations.map(({ from, to, decoration }) => decoration.range(from, to)));
}

const tableEditorField = StateField.define<TableEditorFieldValue>({
  create(state) {
    return {
      decorations: buildTableDecorations(state, false),
      treeLength: syntaxTree(state).length,
      hasFocus: false,
    };
  },
  update(value, transaction) {
    const tree = syntaxTree(transaction.state);
    const treeGrew = tree.length > value.treeLength;
    const refreshRequested = transaction.effects.some((effect) => effect.is(liveMarkdownRefresh));
    const selectionNeedsRebuild = transaction.selection && !isMarkdownSelectionRevealSuppressed();
    let hasFocus = value.hasFocus;
    let focusChanged = false;

    for (const effect of transaction.effects) {
      if (!effect.is(setTableFocus)) continue;
      focusChanged ||= effect.value !== hasFocus;
      hasFocus = effect.value;
    }

    if (
      transaction.docChanged ||
      selectionNeedsRebuild ||
      treeGrew ||
      refreshRequested ||
      focusChanged
    ) {
      return {
        decorations: buildTableDecorations(transaction.state, hasFocus),
        treeLength: tree.length,
        hasFocus,
      };
    }
    return { ...value, hasFocus };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const tableFocusTracker = EditorView.focusChangeEffect.of((_state, focusing) =>
  setTableFocus.of(focusing),
);

export const interactiveTableEditor = [tableEditorField, tableFocusTracker];
