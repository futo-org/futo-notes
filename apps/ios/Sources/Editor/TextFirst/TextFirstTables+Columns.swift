import UIKit

extension NSAttributedString.Key {
    /// The engine's whole-table span, including the delimiter, in live storage coordinates.
    static let tfTableID = NSAttributedString.Key("futo.tf.tableID")
}

extension TextFirstEditorController {
    func styleTable(
        _ extent: NSRange, columns: Int, header: TextFirstTableRowSpan?, window: NSRange
    ) {
        let key: Int
        if let header {
            key = header.tableID
        } else {
            key = nextTableID
            nextTableID += 1
        }
        // A body-only plan resets just its window. Keep the attributed extent on
        // either side, including after an edit above the table shifts it.
        let endsMarked = [extent.location, NSMaxRange(extent) - 1].allSatisfy {
            storage.attribute(.tfTableID, at: $0, effectiveRange: nil) as? Int == key
        }
        let mark = endsMarked ? NSIntersectionRange(extent, window) : extent
        storage.addAttribute(.tfTableID, value: key, range: mark)
        clampTableScroll(key, columns: columns)

        guard let header, header.columns != columns else { return }
        TextFirstTableMetrics.noteWidth = images.containerWidth
        // A pipe in a body row can change the width of rows outside this plan.
        var geometry: [(NSRange, CGFloat)] = []
        storage.enumerateAttribute(.tfTable, in: extent) { value, row, _ in
            guard let span = value as? TextFirstTableRowSpan else { return }
            span.columns = columns
            span.height = TextFirstTableMetrics.height(
                cells: span.cells, header: span.header, columns: columns)
            geometry.append((row, span.height))
        }
        for (row, height) in geometry { applyTableGeometry(storage, row, height: height) }
        invalidateTable(at: extent.location)
    }

    func invalidateTable(at location: Int) {
        guard location < storage.length,
            let manager = textView.textLayoutManager, let content = manager.textContentManager
        else { return }
        var extent = NSRange()
        guard
            storage.attribute(
                .tfTableID, at: location, longestEffectiveRange: &extent,
                in: NSRange(location: 0, length: storage.length)) != nil,
            let a = content.location(manager.documentRange.location, offsetBy: extent.location),
            let b = content.location(a, offsetBy: extent.length),
            let range = NSTextRange(location: a, end: b)
        else { return }
        manager.invalidateLayout(for: range)
        textView.setNeedsDisplay()
    }
}
