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
            syncToolbar()
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
        apply("table key") { try session.tableKey(expected: rev, key: key) }
    }

    /// Put the caret in cell `column` of the table row whose line starts at storage offset
    /// `lineStart`: a selection move, or one edit that gives a short row the cells up to it.
    /// True when the engine did it.
    @discardableResult
    func enterTableCell(lineStart: Int, column: Int) -> Bool {
        guard !closed, !engineComposing,
            let byte = try? mirror.utf16ToByte(unit: UInt64(lineStart))
        else { return false }
        return apply("enter cell") {
            try session.enterTableCell(expected: rev, at: byte, column: UInt32(column))
        }
    }

    /// Apply the engine's table outcome. False when it had nothing to do.
    private func apply(_ context: String, _ call: () throws -> EditorTableOutcome?) -> Bool {
        do {
            guard let outcome = try call() else { return false }
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
            recover(error, context: context)
            return true
        }
    }

    /// Open the cell's editor on this session: scroll its column into view, put the field over
    /// the cell and the caret where `point` (text view coordinates) touched it.
    func openCellEditor(_ hit: TableCellHit, at point: CGPoint? = nil) {
        guard !closed else { return }
        let moved = closeOpenCell()
        // Committing marked text in the cell just closed changed the note's text: the cell
        // touched is found again at its new place, not by the offsets of the hit.
        var hit = hit
        if moved.delta != 0, let fresh = tableCellHit(atStart: moved.shifted(hit.range.location)) {
            hit = fresh
        }
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

    /// Close the open cell's field, committing its marked text. `delta` is how much the note
    /// grew, all of it at the closed cell's start or after: a position past `at` moves by it.
    func closeOpenCell() -> (at: Int, delta: Int, shifted: (Int) -> Int) {
        let at = cellEditor?.cellStart ?? 0
        let length = mirrorLength
        cellEditor?.finish()
        finishComposition()
        let delta = mirrorLength - length
        return (at, delta, { $0 > at ? $0 + delta : $0 })
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
