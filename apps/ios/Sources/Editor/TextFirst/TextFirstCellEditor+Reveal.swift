import UIKit

// Bringing the open cell into view.

extension TextFirstCellEditor {
    /// Scroll the table sideways until the open cell's column shows. Whenever the open cell
    /// changes (a tap, Return, a typed `|` that makes a new column, Undo), not only on a tap.
    func revealColumn() {
        guard !isFinished, let (span, content) = controller.tableCell(at: cellStart) else {
            return
        }
        let line = (controller.storage.string as NSString).paragraphRange(
            for: NSRange(location: cellStart, length: 0))
        controller.revealCell(content, in: span, row: line)
    }

    /// Scroll the note until the whole open cell, with a little margin, is inside what the
    /// keyboard and its toolbar leave visible.
    func scrollCellIntoView(animated: Bool = false) {
        guard !isFinished, let frame = controller.cellFrame(start: cellStart) else { return }
        controller.textView.scrollRectToVisible(frame.insetBy(dx: 0, dy: -12), animated: animated)
    }
}
