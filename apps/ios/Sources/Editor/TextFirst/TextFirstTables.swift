#if FUTO_DEBUG_BUILD
    import UIKit

    // Tables. The engine reports each root GFM table row as one span with its cells' content
    // ranges (`EditorStyleSpan.tableRow`); this draws them as a grid. The row's glyphs (the raw
    // `| a | b |` line) stay in the text but are hidden, the first glyph's kern is as wide as the
    // line and the paragraph's minimum line height is the row's height; the layout fragment draws
    // the cells. The delimiter line is hidden to a hairline. All columns of a table scroll
    // together sideways. Editing a cell happens in `TextFirstCellEditor`, a field on the same
    // engine session; no Markdown is read here.

    extension NSAttributedString.Key {
        /// A `TextFirstTableRowSpan` on the glyphs of one table row line.
        static let tfTable = NSAttributedString.Key("futo.tf.table")
        /// On the glyphs of a table's delimiter line.
        static let tfTableDelimiter = NSAttributedString.Key("futo.tf.tableDelimiter")
    }

    final class TextFirstTableRowSpan: NSObject {
        struct Cell {
            let column: Int
            let text: String
            let alignment: EditorTableAlignment
            /// The cell content's range in the text storage.
            let range: NSRange
        }
        let columns: Int
        let header: Bool
        let tableStart: Int
        let cells: [Cell]
        let height: CGFloat

        init(columns: Int, header: Bool, tableStart: Int, cells: [Cell]) {
            (self.columns, self.header, self.tableStart, self.cells) = (
                columns, header, tableStart, cells
            )
            height = TextFirstTableMetrics.height(cells: cells, header: header)
        }

        func cell(atColumn column: Int) -> Cell? { cells.first { $0.column == column } }
    }

    enum TextFirstTableMetrics {
        static let cellWidth: CGFloat = 160
        static let padding: CGFloat = 10
        static let minimumRow: CGFloat = 44

        static func font(header: Bool) -> UIFont {
            .systemFont(ofSize: 16, weight: header ? .semibold : .regular)
        }

        static func height(cells: [TextFirstTableRowSpan.Cell], header: Bool) -> CGFloat {
            let width = cellWidth - padding * 2
            let tallest =
                cells.map { cell -> CGFloat in
                    (cell.text as NSString).boundingRect(
                        with: CGSize(width: width, height: .greatestFiniteMagnitude),
                        options: .usesLineFragmentOrigin, attributes: [.font: font(header: header)],
                        context: nil
                    ).height.rounded(.up)
                }.max() ?? 0
            return max(minimumRow, tallest + padding * 2)
        }

        /// How far a table of `columns` can scroll in `width` points.
        static func maxScroll(columns: Int, width: CGFloat) -> CGFloat {
            max(0, CGFloat(columns) * cellWidth - width)
        }
    }

    extension TextFirstEditorController {
        /// Hide one table row's glyphs and reserve its grid row. `range` is the row's line
        /// without its line break.
        func styleTableRow(
            _ storage: NSTextStorage, _ range: NSRange, columns: Int, header: Bool, tableStart: Int,
            cells: [EditorStyleCell]
        ) {
            let text = storage.string as NSString
            let parts = cells.compactMap { cell -> TextFirstTableRowSpan.Cell? in
                let s = Int(cell.start)
                let e = min(Int(cell.end), text.length)
                guard s <= e else { return nil }
                return TextFirstTableRowSpan.Cell(
                    column: Int(cell.column),
                    text: text.substring(with: NSRange(location: s, length: e - s)),
                    alignment: cell.alignment, range: NSRange(location: s, length: e - s))
            }
            let span = TextFirstTableRowSpan(
                columns: columns, header: header, tableStart: tableStart, cells: parts)
            storage.addAttributes(
                [
                    .tfTable: span, .font: TextFirstImageMetrics.hiddenFont,
                    .foregroundColor: UIColor.clear, .underlineStyle: 0, .strikethroughStyle: 0,
                    .backgroundColor: UIColor.clear,
                ], range: range)
            applyTableGeometry(storage, range, height: span.height)
        }

        func styleTableDelimiter(_ storage: NSTextStorage, _ range: NSRange) {
            let paragraph = (storage.string as NSString).paragraphRange(for: range)
            storage.addAttributes(
                [
                    .tfTableDelimiter: true, .font: TextFirstImageMetrics.hiddenFont,
                    .foregroundColor: UIColor.clear,
                ], range: paragraph)
            let style = NSMutableParagraphStyle()
            style.minimumLineHeight = 0.01
            style.maximumLineHeight = 0.01
            style.lineSpacing = 0
            storage.addAttribute(.paragraphStyle, value: style, range: paragraph)
        }

        /// A kern as wide as the line on the first glyph, and the row's height.
        func applyTableGeometry(_ storage: NSTextStorage, _ range: NSRange, height: CGFloat) {
            storage.addAttribute(
                .kern, value: max(1, images.containerWidth - 1),
                range: NSRange(location: range.location, length: 1))
            let paragraph = (storage.string as NSString).paragraphRange(for: range)
            let style = NSMutableParagraphStyle()
            style.minimumLineHeight = height
            style.lineSpacing = 0
            storage.addAttribute(.paragraphStyle, value: style, range: paragraph)
        }

        /// The view's width changed: every row's kern follows it.
        func tablesWidthChanged() {
            let all = NSRange(location: 0, length: min(styledThrough, storage.length))
            var rows: [(NSRange, CGFloat)] = []
            storage.enumerateAttribute(.tfTable, in: all) { value, run, _ in
                if let span = value as? TextFirstTableRowSpan { rows.append((run, span.height)) }
            }
            guard !rows.isEmpty else { return }
            storage.beginEditing()
            for (run, height) in rows { applyTableGeometry(storage, run, height: height) }
            storage.endEditing()
        }

        // MARK: hit testing and scrolling

        struct TableCellHit {
            let row: NSRange
            let span: TextFirstTableRowSpan
            let cell: TextFirstTableRowSpan.Cell
        }

        /// The row (and its cell) whose drawn grid holds `p`.
        func tableRowHit(at p: CGPoint) -> (
            row: NSRange, span: TextFirstTableRowSpan, local: CGPoint
        )? {
            guard let manager = textView.textLayoutManager,
                let f = manager.textLayoutFragment(
                    for: CGPoint(x: p.x - inset.left, y: p.y - inset.top))
                    as? TextFirstLayoutFragment, !f.tableRuns.isEmpty
            else { return nil }
            let local = CGPoint(
                x: p.x - inset.left, y: p.y - inset.top - f.layoutFragmentFrame.minY)
            let base = manager.offset(
                from: manager.documentRange.location, to: f.rangeInElement.location)
            for run in f.tableRuns {
                guard let rect = f.tableRect(run), rect.contains(local) else { continue }
                return (
                    NSRange(location: base + run.range.location, length: run.range.length),
                    run.span, local
                )
            }
            return nil
        }

        func tableCellHit(at p: CGPoint) -> TableCellHit? {
            guard let hit = tableRowHit(at: p) else { return nil }
            let scroll = tableScroll[hit.span.tableStart] ?? 0
            let column = Int((hit.local.x + scroll) / TextFirstTableMetrics.cellWidth)
            guard let cell = hit.span.cell(atColumn: column) else { return nil }
            return TableCellHit(row: hit.row, span: hit.span, cell: cell)
        }

        /// Scroll one table's columns together to `x`, redrawing its rows.
        func scrollTable(
            startingAt tableStart: Int, columns: Int, to x: CGFloat, around row: NSRange
        ) {
            let clamped = min(
                max(0, x),
                TextFirstTableMetrics.maxScroll(columns: columns, width: images.containerWidth))
            guard clamped != (tableScroll[tableStart] ?? 0) else { return }
            tableScroll[tableStart] = clamped
            redrawTable(around: row, tableStart: tableStart)
        }

        /// Invalidate the layout of every row of the table that holds `row`.
        func redrawTable(around row: NSRange, tableStart: Int) {
            guard let manager = textView.textLayoutManager, let content = manager.textContentManager
            else { return }
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
            if let a = content.location(manager.documentRange.location, offsetBy: from),
                let b = content.location(
                    manager.documentRange.location, offsetBy: min(to, storage.length)),
                let range = NSTextRange(location: a, end: b)
            {
                manager.invalidateLayout(for: range)
            }
        }

        /// Scroll so the column of `cell` shows (opening its editor).
        func revealCell(
            _ cell: TextFirstTableRowSpan.Cell, in span: TextFirstTableRowSpan, row: NSRange
        ) {
            let width = images.containerWidth
            let left = CGFloat(cell.column) * TextFirstTableMetrics.cellWidth
            let scroll = tableScroll[span.tableStart] ?? 0
            if left < scroll {
                scrollTable(
                    startingAt: span.tableStart, columns: span.columns, to: left, around: row)
            } else if left + TextFirstTableMetrics.cellWidth > scroll + width {
                scrollTable(
                    startingAt: span.tableStart, columns: span.columns,
                    to: left + TextFirstTableMetrics.cellWidth - width, around: row)
            }
        }
    }
#endif
