import { syntaxTree } from '@codemirror/language';
import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

import {
  isMarkdownSelectionRevealSuppressed,
  liveMarkdownRefresh,
  selectionTouchesRange,
} from '../liveMarkdownTransform';
import { TableEditorWidget } from './tableEditorWidget';

interface TableRange {
  from: number;
  to: number;
}

interface TableEditorFieldValue {
  decorations: DecorationSet;
  tables: readonly TableRange[];
  treeLength: number;
  hasFocus: boolean;
}

interface ChangedTableScanRanges {
  scanRanges: TableRange[];
  touchedTableIndexes: ReadonlySet<number>;
}

type MarkdownSyntaxTree = ReturnType<typeof syntaxTree>;

const setTableFocus = StateEffect.define<boolean>();

function rangesOverlapOrTouch(left: TableRange, right: TableRange): boolean {
  return left.from <= right.to && right.from <= left.to;
}

function sortAndDeduplicateTableRanges(tables: readonly TableRange[]): TableRange[] {
  const sorted = [...tables].sort((left, right) => left.from - right.from || left.to - right.to);
  return sorted.filter(
    (table, index) =>
      index === 0 || table.from !== sorted[index - 1].from || table.to !== sorted[index - 1].to,
  );
}

function mergeTableScanRanges(ranges: readonly TableRange[]): TableRange[] {
  const sorted = [...ranges].sort((left, right) => left.from - right.from);
  const merged: TableRange[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.from > previous.to + 1) {
      merged.push({ ...range });
      continue;
    }
    previous.to = Math.max(previous.to, range.to);
  }

  return merged;
}

function expandRangeToMarkdownBlocks(
  state: EditorState,
  from: number,
  to: number,
  parseLimit: number,
): TableRange | null {
  const boundedLimit = Math.min(parseLimit, state.doc.length);
  if (boundedLimit === 0) return null;

  const boundedFrom = Math.max(0, Math.min(from, boundedLimit));
  const boundedTo = Math.max(boundedFrom, Math.min(to, boundedLimit));
  const firstProbe = Math.max(0, boundedFrom - 1);
  const lastProbe = Math.min(boundedLimit, boundedTo + 1);
  let firstLine = state.doc.lineAt(firstProbe);
  let lastLine = state.doc.lineAt(lastProbe);

  while (firstLine.number > 1) {
    const previousLine = state.doc.line(firstLine.number - 1);
    if (previousLine.text.trim() === '') break;
    firstLine = previousLine;
  }

  while (lastLine.number < state.doc.lines) {
    const nextLine = state.doc.line(lastLine.number + 1);
    if (nextLine.from >= boundedLimit || nextLine.text.trim() === '') break;
    lastLine = nextLine;
  }

  return {
    from: firstLine.from,
    to: Math.min(boundedLimit, lastLine.to),
  };
}

function scanTableRanges(
  tree: MarkdownSyntaxTree,
  scanRanges: readonly TableRange[],
): TableRange[] {
  const tables: TableRange[] = [];

  for (const range of scanRanges) {
    if (range.from >= range.to) continue;
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== 'Table') return;
        if (node.to <= tree.length) tables.push({ from: node.from, to: node.to });
        return false;
      },
    });
  }

  return sortAndDeduplicateTableRanges(tables);
}

function scanAllParsedTables(tree: MarkdownSyntaxTree): TableRange[] {
  if (tree.length === 0) return [];
  return scanTableRanges(tree, [{ from: 0, to: tree.length }]);
}

function mapTableRange(table: TableRange, transaction: Transaction): TableRange {
  return {
    from: transaction.changes.mapPos(table.from, 1),
    to: transaction.changes.mapPos(table.to, -1),
  };
}

function getChangedTableScanRanges(
  tables: readonly TableRange[],
  transaction: Transaction,
  parseLimit: number,
): ChangedTableScanRanges {
  const scanRanges: TableRange[] = [];
  const touchedTableIndexes = new Set<number>();

  transaction.changes.iterChangedRanges((fromBefore, toBefore, fromAfter, toAfter) => {
    let scanFrom = fromAfter;
    let scanTo = toAfter;

    for (const [tableIndex, table] of tables.entries()) {
      if (fromBefore > table.to || toBefore < table.from) continue;
      touchedTableIndexes.add(tableIndex);
      const mappedTable = mapTableRange(table, transaction);
      scanFrom = Math.min(scanFrom, mappedTable.from);
      scanTo = Math.max(scanTo, mappedTable.to);
    }

    const expandedRange = expandRangeToMarkdownBlocks(
      transaction.state,
      scanFrom,
      scanTo,
      parseLimit,
    );
    if (expandedRange) scanRanges.push(expandedRange);
  });

  return {
    scanRanges: mergeTableScanRanges(scanRanges),
    touchedTableIndexes,
  };
}

function replaceTablesInScanRanges(
  tables: readonly TableRange[],
  tree: MarkdownSyntaxTree,
  scanRanges: readonly TableRange[],
): TableRange[] {
  const retainedTables = tables.filter(
    (table) =>
      table.from < table.to &&
      !scanRanges.some((scanRange) => rangesOverlapOrTouch(table, scanRange)),
  );
  const rescannedTables = scanTableRanges(tree, scanRanges);
  return sortAndDeduplicateTableRanges([...retainedTables, ...rescannedTables]);
}

function updateTablesAfterDocumentChange(
  value: TableEditorFieldValue,
  transaction: Transaction,
  tree: MarkdownSyntaxTree,
): TableRange[] {
  const mappedTables = value.tables.map((table) => mapTableRange(table, transaction));
  const { scanRanges, touchedTableIndexes } = getChangedTableScanRanges(
    value.tables,
    transaction,
    tree.length,
  );
  const untouchedMappedTables = mappedTables.filter(
    (_table, tableIndex) => !touchedTableIndexes.has(tableIndex),
  );
  return replaceTablesInScanRanges(untouchedMappedTables, tree, scanRanges);
}

function updateTablesAfterTreeGrowth(
  value: TableEditorFieldValue,
  state: EditorState,
  tree: MarkdownSyntaxTree,
): TableRange[] {
  const expandedRange = expandRangeToMarkdownBlocks(
    state,
    value.treeLength,
    tree.length,
    tree.length,
  );
  if (!expandedRange) return [...value.tables];
  return replaceTablesInScanRanges(value.tables, tree, [expandedRange]);
}

function buildTableDecorations(
  state: EditorState,
  hasFocus: boolean,
  tables: readonly TableRange[],
): DecorationSet {
  const decorations: Array<{ from: number; to: number; decoration: Decoration }> = [];

  for (const table of tables) {
    if (selectionTouchesRange(hasFocus, state.selection.ranges, table.from, table.to)) continue;

    const source = state.doc.sliceString(table.from, table.to);
    decorations.push({
      from: table.from,
      to: table.to,
      decoration: Decoration.replace({
        widget: new TableEditorWidget(source, table.from, table.to),
        block: true,
      }),
    });
  }

  return RangeSet.of(decorations.map(({ from, to, decoration }) => decoration.range(from, to)));
}

function createTableEditorFieldValue(
  state: EditorState,
  tree: MarkdownSyntaxTree,
  tables: readonly TableRange[],
  hasFocus: boolean,
): TableEditorFieldValue {
  // Recreate widgets from current ranges because each widget retains its constructor offsets.
  return {
    decorations: buildTableDecorations(state, hasFocus, tables),
    tables,
    treeLength: tree.length,
    hasFocus,
  };
}

const tableEditorField = StateField.define<TableEditorFieldValue>({
  create(state) {
    const tree = syntaxTree(state);
    const tables = scanAllParsedTables(tree);
    return createTableEditorFieldValue(state, tree, tables, false);
  },
  update(value, transaction) {
    const tree = syntaxTree(transaction.state);
    const refreshRequested = transaction.effects.some((effect) => effect.is(liveMarkdownRefresh));
    const selectionNeedsRebuild = transaction.selection && !isMarkdownSelectionRevealSuppressed();
    let hasFocus = value.hasFocus;
    let focusChanged = false;

    for (const effect of transaction.effects) {
      if (!effect.is(setTableFocus)) continue;
      focusChanged ||= effect.value !== hasFocus;
      hasFocus = effect.value;
    }

    if (refreshRequested || focusChanged) {
      const tables = scanAllParsedTables(tree);
      return createTableEditorFieldValue(transaction.state, tree, tables, hasFocus);
    }

    if (transaction.docChanged) {
      const tables = updateTablesAfterDocumentChange(value, transaction, tree);
      return createTableEditorFieldValue(transaction.state, tree, tables, hasFocus);
    }

    if (tree.length > value.treeLength) {
      const tables = updateTablesAfterTreeGrowth(value, transaction.state, tree);
      return createTableEditorFieldValue(transaction.state, tree, tables, hasFocus);
    }

    if (tree.length < value.treeLength) {
      // A restarted parse invalidates the discovery frontier, not known table ranges.
      return createTableEditorFieldValue(transaction.state, tree, value.tables, hasFocus);
    }

    if (selectionNeedsRebuild) {
      return createTableEditorFieldValue(transaction.state, tree, value.tables, hasFocus);
    }

    return { ...value, hasFocus };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

const tableFocusTracker = EditorView.focusChangeEffect.of((_state, focusing) =>
  setTableFocus.of(focusing),
);

export const interactiveTableEditor = [tableEditorField, tableFocusTracker];
