import UIKit

// A tap in a box a short row draws but lacks.

extension TextFirstEditorController {
    /// The table row above the one at `row` (looking through the delimiter line), with its range.
    private func tableRowAbove(_ row: NSRange) -> (NSRange, TextFirstTableRowSpan)? {
        let text = storage.string as NSString
        var at = row.location
        for _ in 0..<2 {
            guard at > 0 else { return nil }
            let line = text.paragraphRange(for: NSRange(location: at - 1, length: 0))
            var run = NSRange()
            if let span = storage.attribute(
                .tfTable, at: line.location, longestEffectiveRange: &run, in: line)
                as? TextFirstTableRowSpan
            {
                return (run, span)
            }
            at = line.location
        }
        return nil
    }

    /// A tap in a box the row lacks: the engine's own table key enters it, giving the row its
    /// missing cells in ONE edit, and the field opens there. From the row's last cell a Tab
    /// enters the next column; from the cell above in the tapped column an Enter enters it
    /// (however many cells that fills). Any other box would take several keys (several Undo
    /// steps), so it does nothing, as before. True when the tap was a missing box.
    func openMissingCell(at p: CGPoint) -> Bool {
        guard let hit = tableRowHit(at: p) else { return false }
        let scroll = tableScroll[hit.span.tableStart] ?? 0
        let column = Int(
            (hit.local.x + scroll) / TextFirstTableMetrics.cellWidth(columns: hit.span.columns))
        guard column >= 0, column < hit.span.columns, hit.span.cell(atColumn: column) == nil
        else { return false }
        var from: (NSRange, EditorTableKey)?
        if let last = hit.span.cells.max(by: { $0.column < $1.column }),
            last.column + 1 == column
        {
            from = (hit.span.contentRange(of: last, row: hit.row), .tab)
        } else if let (row, span) = tableRowAbove(hit.row), let cell = span.cell(atColumn: column) {
            from = (span.contentRange(of: cell, row: row), .enter)
        }
        guard let (range, key) = from else { return true }
        cellEditor?.finish()
        finishComposition()
        selectInCell(NSRange(location: NSMaxRange(range), length: 0))
        if tableKey(key) {
            openCellEditorAtSelection()
            cellEditor?.scrollCellIntoView()
        }
        return true
    }
}
