/* The table rows drawn since the editor's last frame (tableRowElements.ts `drawRow`): a row
 * drawn fresh takes its table's sideways scroll on that frame (tableLayouts.ts `applyTo`). */

/** Rows drawn since the last frame, from every view: a view takes those that are its own. */
const drawnRows = new Set<HTMLElement>();

/** `row` was drawn: it takes its table's scroll on the view's next frame. */
export function markTableRowDrawn(row: HTMLElement): void {
  drawnRows.add(row);
}

/** The rows drawn since the last call that are in `editor`; the others are dropped. */
export function takeDrawnTableRows(editor: HTMLElement): HTMLElement[] {
  const rows = [...drawnRows].filter((row) => editor.contains(row));
  drawnRows.clear();
  return rows;
}
