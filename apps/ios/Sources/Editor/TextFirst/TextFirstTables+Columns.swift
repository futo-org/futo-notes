import UIKit

// One column count per table.

extension TextFirstEditorController {
    /// The lines of the table that holds `row` (header to last row, delimiter included).
    func tableExtent(around row: NSRange, tableStart: Int) -> NSRange {
        let text = storage.string as NSString
        var from = row.location
        var to = NSMaxRange(row)
        func belongs(_ at: Int) -> Bool {
            guard at >= 0, at < storage.length else { return false }
            if let span = storage.attribute(.tfTable, at: at, effectiveRange: nil)
                as? TextFirstTableRowSpan
            {
                return span.tableStart == tableStart
            }
            return storage.attribute(.tfTableDelimiter, at: at, effectiveRange: nil) != nil
        }
        while from > 0,
            belongs(text.paragraphRange(for: NSRange(location: from - 1, length: 0)).location)
        {
            from = text.paragraphRange(for: NSRange(location: from - 1, length: 0)).location
        }
        while to < storage.length, belongs(to) {
            to = NSMaxRange(text.paragraphRange(for: NSRange(location: to, length: 0)))
        }
        return NSRange(location: from, length: min(to, storage.length) - from)
    }

    /// Invalidate the layout of every row of the table that holds `row`.
    func invalidateTable(around row: NSRange, tableStart: Int) {
        guard let manager = textView.textLayoutManager, let content = manager.textContentManager
        else { return }
        let extent = tableExtent(around: row, tableStart: tableStart)
        if let a = content.location(manager.documentRange.location, offsetBy: extent.location),
            let b = content.location(
                manager.documentRange.location, offsetBy: NSMaxRange(extent)),
            let range = NSTextRange(location: a, end: b)
        {
            manager.invalidateLayout(for: range)
        }
    }

    /// The engine restyles only the rows an edit meets, and says each row's own column count.
    /// Every row of a table is drawn with the count of its widest row: after a style pass over
    /// `window`, every table it touched is made uniform, rows outside the window included,
    /// and redrawn when its count changed (a typed `|`, its Undo, Delete column).
    func settleTableColumns(in window: NSRange) {
        var tables: [(key: Int, row: NSRange)] = []
        storage.enumerateAttribute(.tfTable, in: window) { value, run, _ in
            if let span = value as? TextFirstTableRowSpan,
                !tables.contains(where: { $0.key == span.tableStart })
            {
                tables.append((span.tableStart, run))
            }
        }
        for (key, row) in tables {
            var rows: [(NSRange, TextFirstTableRowSpan)] = []
            storage.enumerateAttribute(
                .tfTable, in: tableExtent(around: row, tableStart: key)
            ) { value, run, _ in
                if let span = value as? TextFirstTableRowSpan { rows.append((run, span)) }
            }
            let widest = rows.map { $0.1.rawColumns }.max() ?? 0
            let changed = rows.filter { $0.1.columns != widest }
            guard !changed.isEmpty else { continue }
            clampTableScroll(key, columns: widest)
            storage.beginEditing()
            for (run, span) in changed {
                span.columns = widest
                span.height = TextFirstTableMetrics.height(
                    cells: span.cells, header: span.header, columns: widest)
                applyTableGeometry(storage, run, height: span.height)
            }
            storage.endEditing()
            invalidateTable(around: row, tableStart: key)
        }
    }
}
