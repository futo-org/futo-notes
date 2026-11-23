import UIKit

// A tap in a box a short row draws but lacks, and the keystroke that finishes a typed table.

extension TextFirstEditorController {
    /// A tap in a box the row lacks: the engine enters that column of the touched row, giving
    /// the row its missing cells in ONE edit, and the field opens there. True when the tap was
    /// a missing box.
    func openMissingCell(at p: CGPoint) -> Bool {
        guard let hit = tableRowHit(at: p) else { return false }
        let scroll = tableScroll[hit.span.tableID] ?? 0
        let column = Int(
            (hit.local.x + scroll) / TextFirstTableMetrics.cellWidth(columns: hit.span.columns))
        guard column >= 0, column < hit.span.columns, hit.span.cell(atColumn: column) == nil
        else { return false }
        cellEditor?.finish()
        finishComposition()
        if enterTableCell(lineStart: hit.row.location, column: column) {
            openCellEditorAtSelection()
            cellEditor?.scrollCellIntoView()
        }
        return true
    }

    /// The keystroke that finishes a typed delimiter row puts the engine's caret in the first
    /// body cell: open its field, as a tap on that cell would (Android does the same).
    func openCellAfterDelimiterRow(_ change: EditorViewChange) {
        let finished = writesDelimiterRow && !change.writesDelimiterRow
        writesDelimiterRow = change.writesDelimiterRow
        guard finished else { return }
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.closed, !self.engineBusy else { return }
                self.openCellEditorAtSelection()
            }
        }
    }
}
