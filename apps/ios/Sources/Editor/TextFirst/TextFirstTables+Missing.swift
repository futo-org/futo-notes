import UIKit

// A tap in a box a short row draws but lacks.

extension TextFirstEditorController {
    /// Use the touched row's existing cell to find its current index. An edit above
    /// it may have shifted that index since TextKit last drew the row.
    private func cellAbove(
        _ row: NSRange, span: TextFirstTableRowSpan, column: Int
    ) -> NSRange? {
        guard !span.header, let first = span.cells.first,
            let anchor = try? mirror.utf16ToByte(
                unit: UInt64(span.contentRange(of: first, row: row).location)),
            let table = try? session.inspectTable(
                expected: rev, range: EditorByteRange(start: anchor, end: anchor)),
            let focus = table.focus, focus.row > 0,
            let cell = table.rows[Int(focus.row) - 1].first(where: { Int($0.column) == column }),
            let end = try? mirror.byteToUtf16(byte: cell.content.end)
        else { return nil }
        return NSRange(location: Int(end), length: 0)
    }

    /// A tap in a box the row lacks: the engine's own table key enters it, giving the row its
    /// missing cells in ONE edit, and the field opens there. From the row's last cell a Tab
    /// enters the next column; from the cell above in the tapped column an Enter enters it
    /// (however many cells that fills). Any other box would take several keys (several Undo
    /// steps), so it does nothing, as before. True when the tap was a missing box.
    func openMissingCell(at p: CGPoint) -> Bool {
        guard let hit = tableRowHit(at: p) else { return false }
        let scroll = tableScroll[hit.span.tableID] ?? 0
        let column = Int(
            (hit.local.x + scroll) / TextFirstTableMetrics.cellWidth(columns: hit.span.columns))
        guard column >= 0, column < hit.span.columns, hit.span.cell(atColumn: column) == nil
        else { return false }
        var from: (NSRange, EditorTableKey)?
        if let last = hit.span.cells.max(by: { $0.column < $1.column }),
            last.column + 1 == column
        {
            from = (hit.span.contentRange(of: last, row: hit.row), .tab)
        } else if let above = cellAbove(hit.row, span: hit.span, column: column) {
            from = (above, .enter)
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
