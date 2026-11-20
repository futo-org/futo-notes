import UIKit

extension TextFirstCellEditor {
    /// The engine's inline styling of the cell's text (bold, italic, strikethrough, code, links;
    /// the display hides the markers), set on the field's storage in place: its text and caret
    /// are left alone. It is the same styling the closed grid draws (`TextFirstTableMetrics.style`).
    func styleInline() {
        let length = field.textStorage.length
        let c = controller
        guard field.markedTextRange == nil, !c.engineBusy,
            let start = try? c.mirror.utf16ToByte(unit: UInt64(anchor)),
            let end = try? c.mirror.utf16ToByte(unit: UInt64(anchor + length)),
            let specs = try? c.session.stylePlan(
                expected: c.rev, range: EditorByteRange(start: start, end: end))
        else { return }
        let runs = TextFirstTableMetrics.runs(from: specs, origin: anchor, length: length)
        linkRuns = runs
        let signature =
            runs.map {
                "\($0.range)\($0.bold)\($0.italic)\($0.strike)\($0.code)\(String(describing: $0.link))"
            }.joined(separator: ";") + "|\(length)|\(header)"
        let base = TextFirstTableMetrics.font(header: header)
        field.typingAttributes[.font] = base
        field.typingAttributes[.foregroundColor] = UIColor.label
        field.typingAttributes[.strikethroughStyle] = nil
        field.typingAttributes[.underlineStyle] = nil
        field.typingAttributes[.backgroundColor] = nil
        guard signature != styled else { return }
        styled = signature
        applying += 1
        let storage = field.textStorage
        storage.beginEditing()
        TextFirstTableMetrics.style(storage, runs: runs, header: header)
        storage.endEditing()
        applying -= 1
    }
}
