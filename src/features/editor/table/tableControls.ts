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

    const header = root.querySelectorAll('thead th')[column] as HTMLElement | undefined;
    if (header) controls.style.left = `${header.offsetLeft}px`;
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

    const tableRow = root.querySelectorAll('tbody tr')[row] as HTMLElement | undefined;
    if (tableRow) controls.style.top = `${tableRow.offsetTop}px`;
    root.appendChild(controls);
  });

  attachTableDropHandlers(root, mutateTable);
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
