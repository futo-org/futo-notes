import UIKit

// The cell editor's engine calls on the note's controller (split from TextFirstCellEditor.swift).

extension TextFirstEditorController {
    /// One edit inside a cell, reported to the engine as the note's own input would be.
    func replaceInCell(range: NSRange, text: String) {
        guard !closed else { return }
        let units = Array(text.utf16)
        do {
            let change: EditorViewChange?
            if range.length > 0, !units.isEmpty {
                change = try session.replaceOsUtf16(
                    expected: rev, range: Self.range(range), text: units, placeholders: [])
            } else {
                change = try session.replaceUtf16Action(
                    expected: rev, range: Self.range(range), inserted: units,
                    action: units.count > 1 || range.length > 1 ? .isolated : .typing)
            }
            if let change { try accept(change) }
        } catch { recover(error, context: "cell edit") }
    }

    func selectInCell(_ range: NSRange) {
        guard !closed else { return }
        do {
            let change = try session.selectUtf16(expected: rev, range: Self.range(range))
            rev = change.revision
            let start = try mirror.byteToUtf16(byte: change.selection.start)
            let end = try mirror.byteToUtf16(byte: change.selection.end)
            setSelection(NSRange(location: Int(start), length: Int(end - start)))
        } catch { recover(error, context: "cell selection") }
    }

    func composeInCell(range: NSRange, text: String) {
        guard !closed else { return }
        if !engineComposing {
            engineComposing = true
            compositionRange = range
        }
        do {
            _ = try session.composeUtf16(
                expected: rev, range: Self.range(compositionRange), text: Array(text.utf16))
        } catch {
            engineComposing = false
            recover(error, context: "cell compose")
        }
        lastMarked = text
    }

    func commitCellComposition(committed: String?) {
        engineComposing = false
        do {
            let text = committed.flatMap { $0 == lastMarked ? nil : Array($0.utf16) }
            if let change = try session.commitCompositionUtf16(expected: rev, text: text) {
                try accept(change)
            }
        } catch { recover(error, context: "cell commit") }
    }

    /// A table key (Tab, Enter, ...): a selection move or one accepted edit. True when handled.
    @discardableResult
    func tableKey(_ key: EditorTableKey) -> Bool {
        guard !closed, !engineComposing else { return false }
        do {
            guard let outcome = try session.tableKey(expected: rev, key: key) else {
                return false
            }
            if let change = outcome.edited {
                try accept(change)
            } else if let moved = outcome.selected {
                rev = moved.revision
                let start = try mirror.byteToUtf16(byte: moved.selection.start)
                let end = try mirror.byteToUtf16(byte: moved.selection.end)
                setSelection(NSRange(location: Int(start), length: Int(end - start)))
                onAccepted?()
            }
            return true
        } catch {
            recover(error, context: "table key")
            return true
        }
    }

    /// Open the cell's editor on this session: scroll its column into view, put the field over
    /// the cell and the caret where `point` (text view coordinates) touched it.
    func openCellEditor(_ hit: TableCellHit, at point: CGPoint? = nil) {
        guard !closed else { return }
        cellEditor?.finish()
        finishComposition()
        let before = tableScroll[hit.span.tableID] ?? 0
        revealCell(hit.cell, in: hit.span, row: hit.row)
        let shift = (tableScroll[hit.span.tableID] ?? 0) - before
        selectInCell(NSRange(location: NSMaxRange(hit.range), length: 0))
        let editor = TextFirstCellEditor(controller: self)
        cellEditor = editor
        editor.install()
        if let point { editor.placeCaret(at: CGPoint(x: point.x - shift, y: point.y)) }
        if let frame = cellFrame(start: hit.range.location) {
            textView.scrollRectToVisible(frame.insetBy(dx: 0, dy: -60), animated: false)
        }
    }

    /// the engine's selection is in a table cell but no field is open (Undo of
    /// Delete table, which closes the field first): open the field there, as a tap would.
    func openCellEditorAtSelection() {
        guard !closed, cellEditor == nil,
            let view = try? session.cellView(
                expected: rev, selection: Self.range(engineSelection)),
            view.start <= view.end
        else { return }
        let editor = TextFirstCellEditor(controller: self)
        cellEditor = editor
        editor.install()
    }
}
