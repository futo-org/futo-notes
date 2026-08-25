import { renderIcon } from '../editorUX/icons';
import type { ParsedTable, TableAlignment } from './tableModel';
import {
  addColumn,
  addRow,
  cycleAlign,
  deleteColumn,
  deleteRow,
  moveColumn,
  moveRow,
  setAlign,
} from './tableOperations';

const DRAG_MIME_ROW = 'application/x-sf-table-row';
const DRAG_MIME_COLUMN = 'application/x-sf-table-col';

interface AttachTableControlsParams {
  root: HTMLElement;
  table: ParsedTable;
  mutateTable: (mutation: (table: ParsedTable) => ParsedTable) => void;
}

function alignmentIconName(alignment: TableAlignment): string {
  if (alignment === 'center') return 'AlignCenter';
  if (alignment === 'right') return 'AlignRight';
  return 'AlignLeft';
}

function createControlButton(
  label: string,
  icon: Parameters<typeof renderIcon>[0],
  action: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.innerHTML = renderIcon(icon);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', action);
  return button;
}

function attachTableDropHandlers(
  root: HTMLElement,
  mutateTable: AttachTableControlsParams['mutateTable'],
): void {
  root.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return;
    const isRow = event.dataTransfer.types.includes(DRAG_MIME_ROW);
    const isColumn = event.dataTransfer.types.includes(DRAG_MIME_COLUMN);
    if (!isRow && !isColumn) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });

  root.addEventListener('drop', (event) => {
    if (!event.dataTransfer) return;
    const target = event.target as HTMLElement;

    if (event.dataTransfer.types.includes(DRAG_MIME_ROW)) {
      const fromRow = Number.parseInt(event.dataTransfer.getData(DRAG_MIME_ROW), 10);
      const toRow = Number.parseInt(
        (target.closest('tr') as HTMLElement | null)?.dataset.rowIndex ?? '-1',
        10,
      );
      if (!Number.isNaN(fromRow) && toRow >= 0) {
        event.preventDefault();
        mutateTable((table) => moveRow(table, fromRow, toRow));
      }
      return;
    }

    if (!event.dataTransfer.types.includes(DRAG_MIME_COLUMN)) return;
    const fromColumn = Number.parseInt(event.dataTransfer.getData(DRAG_MIME_COLUMN), 10);
    const columnElement = target.closest('th') ?? target.closest('td');
    const row = columnElement?.parentElement as HTMLTableRowElement | null;
    if (!columnElement || !row || Number.isNaN(fromColumn)) return;

    const toColumn = Array.from(row.children).indexOf(columnElement);
    if (toColumn < 0) return;
    event.preventDefault();
    mutateTable((table) => moveColumn(table, fromColumn, toColumn));
  });
}

export function attachTableControls({ root, table, mutateTable }: AttachTableControlsParams): void {
  root
    .querySelectorAll('.sf-table__row-controls, .sf-table__col-controls')
    .forEach((element) => element.remove());

  table.headers.forEach((_, column) => {
    const controls = document.createElement('div');
    controls.className = 'sf-table__col-controls';
    controls.dataset.col = String(column);

    const drag = createControlButton('Drag column', 'GripVertical', () => undefined);
    drag.className = 'sf-table__drag';
    drag.draggable = true;
    drag.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData(DRAG_MIME_COLUMN, String(column));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    controls.appendChild(drag);
    controls.appendChild(
      createControlButton('Add column to right', 'Plus', () => {
        mutateTable((current) => addColumn(current, column + 1));
      }),
    );

    const alignButton = createControlButton(
      'Cycle alignment',
      alignmentIconName(table.alignments[column] ?? 'left'),
      () => {
        mutateTable((current) =>
          setAlign(current, column, cycleAlign(current.alignments[column] ?? 'left')),
        );
      },
    );
    alignButton.dataset.role = 'align';
    controls.appendChild(alignButton);
    controls.appendChild(
      createControlButton('Delete column', 'Trash', () => {
        mutateTable((current) => deleteColumn(current, column));
      }),
    );

    controls.dataset.col = String(column);
    root.appendChild(controls);
  });

  table.rows.forEach((_, row) => {
    const controls = document.createElement('div');
    controls.className = 'sf-table__row-controls';
    controls.dataset.row = String(row);

    const drag = createControlButton('Drag row', 'GripVertical', () => undefined);
    drag.className = 'sf-table__drag';
    drag.draggable = true;
    drag.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData(DRAG_MIME_ROW, String(row));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    controls.appendChild(drag);
    controls.appendChild(
      createControlButton('Add row below', 'Plus', () => {
        mutateTable((current) => addRow(current, row + 1));
      }),
    );
    controls.appendChild(
      createControlButton('Delete row', 'Trash', () => {
        mutateTable((current) => deleteRow(current, row));
      }),
    );

    root.appendChild(controls);
  });

  attachTableDropHandlers(root, mutateTable);
}

/**
 * Place the hover tabs against the rows and columns they act on. Deliberately
 * NOT done while building: `attachTableControls` runs inside `toDOM`, where the
 * widget is still detached and every offset reads 0, so every tab stacked at the
 * table's top-left corner. Called when the tabs are about to become visible, and
 * again while they are visible and the table scrolls sideways.
 *
 * Measured from `getBoundingClientRect`, not `offsetTop`/`offsetLeft`: those are
 * layout-relative so they ignore `scrollLeft`, and for a `tr` under
 * `border-collapse: collapse` offsetTop reads ~8px short, which used to leave the
 * tab hanging above its row.
 */
export function positionTableControls(root: HTMLElement): void {
  const scroller = root.querySelector<HTMLElement>('.sf-table__scroll');
  const rootRect = root.getBoundingClientRect();
  const scrollerRect = scroller?.getBoundingClientRect();
  const headers = root.querySelectorAll<HTMLElement>('thead th');
  const bodyRows = root.querySelectorAll<HTMLElement>('tbody tr');

  root.querySelectorAll<HTMLElement>('.sf-table__col-controls').forEach((controls) => {
    const header = headers[Number.parseInt(controls.dataset.col ?? '-1', 10)];
    if (!header) return;
    const headerRect = header.getBoundingClientRect();
    controls.style.left = `${headerRect.left - rootRect.left}px`;
    const offScreen =
      !!scrollerRect &&
      (headerRect.left < scrollerRect.left - 1 || headerRect.left > scrollerRect.right);
    controls.style.visibility = offScreen ? 'hidden' : '';
  });

  root.querySelectorAll<HTMLElement>('.sf-table__row-controls').forEach((controls) => {
    const row = bodyRows[Number.parseInt(controls.dataset.row ?? '-1', 10)];
    if (!row) return;
    const rowRect = row.getBoundingClientRect();
    const centred = (rowRect.height - controls.getBoundingClientRect().height) / 2;
    controls.style.top = `${rowRect.top - rootRect.top + centred}px`;
  });
}

export function updateTableControlAlignments(root: HTMLElement, table: ParsedTable): void {
  root.querySelectorAll<HTMLElement>('.sf-table__col-controls').forEach((controls) => {
    const column = Number.parseInt(controls.dataset.col ?? '-1', 10);
    if (column < 0) return;
    const button = controls.querySelector<HTMLElement>('[data-role="align"]');
    if (button)
      button.innerHTML = renderIcon(alignmentIconName(table.alignments[column] ?? 'left'));
  });
}
