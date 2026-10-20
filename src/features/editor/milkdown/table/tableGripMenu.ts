import { type Command } from '@milkdown/kit/prose/state';
import { localizedText } from '$shared/localization';
import {
  canInsertRowBefore,
  columnDeleteDisabledReason,
  deleteColumnAt,
  deleteRowAt,
  insertColumnAfter,
  insertColumnBefore,
  insertRowAfter,
  insertRowBefore,
  rowDeleteDisabledReason,
  type CellLocation,
} from './tableCommands';

export type GripKind = 'row' | 'col';

export interface MenuAction {
  label: string;
  disabled: boolean;
  disabledReason: string | null;
  run: Command;
}

/** The three menu entries for whichever grip was clicked, in the fixed
 * order the spec calls for. */
export function menuActionsFor(kind: GripKind, pos: number, loc: CellLocation): MenuAction[] {
  if (kind === 'row') {
    const insertBeforeAllowed = canInsertRowBefore(loc);
    const deleteReason = rowDeleteDisabledReason(loc);
    return [
      {
        label: localizedText('editor.tableGrips.insertBefore'),
        disabled: !insertBeforeAllowed,
        disabledReason: insertBeforeAllowed
          ? null
          : localizedText('editor.tableGrips.headerRowMustStayFirst'),
        run: insertRowBefore(pos),
      },
      {
        label: localizedText('editor.tableGrips.insertAfter'),
        disabled: false,
        disabledReason: null,
        run: insertRowAfter(pos),
      },
      {
        label: localizedText('editor.tableGrips.delete'),
        disabled: deleteReason !== null,
        disabledReason: deleteReason,
        run: deleteRowAt(pos),
      },
    ];
  }
  const deleteReason = columnDeleteDisabledReason(loc);
  return [
    {
      label: localizedText('editor.tableGrips.insertBefore'),
      disabled: false,
      disabledReason: null,
      run: insertColumnBefore(pos),
    },
    {
      label: localizedText('editor.tableGrips.insertAfter'),
      disabled: false,
      disabledReason: null,
      run: insertColumnAfter(pos),
    },
    {
      label: localizedText('editor.tableGrips.delete'),
      disabled: deleteReason !== null,
      disabledReason: deleteReason,
      run: deleteColumnAt(pos),
    },
  ];
}

/** The first cell in the target row/column, as (row, col) into the table's
 * grid. Shared by {@link anchorPos} and {@link cellStartPos} so the two
 * position conventions below always agree on WHICH cell. */
export function firstCellOf(loc: CellLocation, kind: GripKind): { row: number; col: number } {
  return kind === 'row' ? { row: loc.top, col: 0 } : { row: 0, col: loc.left };
}

/** The document position `tableCommands.ts` should act on for `loc`: any
 * position inside the target row/column's first cell in that line —
 * `locateCell`/`cellAround` resolve the same cell from anywhere in its
 * subtree, so one step inside its opening tag is enough and keeps this off
 * the boundary (never resolving to the PRECEDING cell instead). */
export function anchorPos(loc: CellLocation, kind: GripKind): number {
  const { row, col } = firstCellOf(loc, kind);
  return loc.tableStart + loc.map.positionAt(row, col, loc.table) + 1;
}

/**
 * The exact cell-start position `CellSelection.rowSelection`/`colSelection`
 * require: NO offset into the cell. Its constructor reads `$anchorCell.node(-1)`
 * expecting the TABLE — one past the boundary would resolve one depth too
 * deep (inside the cell's own content) and hand it the CELL instead,
 * throwing when `TableMap.get` is called on a non-table node. This is a
 * different position than `anchorPos` on purpose, not the same value reused.
 */
export function cellStartPos(loc: CellLocation, kind: GripKind): number {
  const { row, col } = firstCellOf(loc, kind);
  return loc.tableStart + loc.map.positionAt(row, col, loc.table);
}
