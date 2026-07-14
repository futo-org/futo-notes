import type { ParsedTable } from './tableModel';

interface TableCellNavigationOptions {
  addRow: (rowIndex: number) => void;
  flushPendingSync: () => void;
  getBodyCells: () => HTMLElement[][];
  getHeaderCells: () => HTMLElement[];
  getTable: () => ParsedTable;
  leaveTable: () => void;
}

function isCaretAtEnd(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const probe = document.createRange();
  probe.selectNodeContents(element);
  probe.setStart(range.endContainer, range.endOffset);
  return probe.toString() === '';
}

function isCaretAtStart(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const probe = document.createRange();
  probe.selectNodeContents(element);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString() === '';
}

export function createTableCellNavigation(options: TableCellNavigationOptions) {
  function focusCell(row: number, column: number): void {
    const element =
      row === -1 ? options.getHeaderCells()[column] : options.getBodyCells()[row]?.[column];
    if (!element) return;

    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function moveFocus(row: number, column: number, delta: number): void {
    const table = options.getTable();
    const rowCount = table.rows.length;
    const columnCount = table.headers.length;
    if (delta === +Infinity) {
      if (row + 1 < rowCount) focusCell(row + 1, column);
      return;
    }
    if (delta === -Infinity) {
      if (row > 0) focusCell(row - 1, column);
      else if (row === 0) focusCell(-1, column);
      return;
    }

    let nextRow = row;
    let nextColumn = column + delta;
    if (nextColumn >= columnCount) {
      nextColumn = 0;
      nextRow += 1;
    } else if (nextColumn < 0) {
      nextColumn = columnCount - 1;
      nextRow -= 1;
    }
    if (nextRow >= rowCount) {
      options.flushPendingSync();
      options.addRow(rowCount);
      queueMicrotask(() => focusCell(rowCount, 0));
      return;
    }
    if (nextRow === -2) {
      focusCell(-1, columnCount - 1);
      return;
    }
    focusCell(nextRow, nextColumn);
  }

  function handleKeydown(
    event: KeyboardEvent,
    row: number,
    column: number,
    element: HTMLElement,
  ): void {
    if (event.key === 'Tab') {
      event.preventDefault();
      moveFocus(row, column, event.shiftKey ? -1 : 1);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      options.flushPendingSync();
      options.addRow(row + 1);
      queueMicrotask(() => focusCell(row + 1, column));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      options.flushPendingSync();
      options.leaveTable();
    } else if (event.key === 'ArrowDown' && isCaretAtEnd(element)) {
      event.preventDefault();
      moveFocus(row, column, +Infinity);
    } else if (event.key === 'ArrowUp' && isCaretAtStart(element)) {
      event.preventDefault();
      moveFocus(row, column, -Infinity);
    }
  }

  return { handleKeydown };
}
