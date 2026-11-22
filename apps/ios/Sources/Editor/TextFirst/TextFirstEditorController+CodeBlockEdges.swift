import UIKit

// A code block's fences are hidden, and Enter in its code stays in it, so a block that ends the
// note has no line after it to tap or type into, and one that starts the note none before it.
// A tap in the empty space below such a block opens a line after it, and a tap above one opens a
// line before it (the engine's OpenLineAfterCodeBlock / OpenLineBeforeCodeBlock), as on Android.

extension TextFirstEditorController {
    /// The line a tap at `p` (text view coordinates) opens beside a code block at the note's
    /// edge; nil anywhere else.
    func codeBlockEdge(at p: CGPoint) -> EditorBlockCommand? {
        // A note that is only an empty block has no character to style: the engine says whether
        // it is code, and its one line is the caret's row.
        if storage.length == 0 {
            guard !engineBusy,
                let blocks = try? session.project(
                    expected: rev, range: EditorByteRange(start: 0, end: 0)
                ).codeBlocks, !blocks.isEmpty
            else { return nil }
            let row = textView.caretRect(for: textView.beginningOfDocument)
            if p.y > row.maxY { return .openLineAfterCodeBlock }
            if p.y < row.minY { return .openLineBeforeCodeBlock }
            return nil
        }
        guard let manager = textView.textLayoutManager,
            let shown = manager.textViewportLayoutController.viewportRange
        else { return nil }
        // Only an edge on screen is asked about: laying out a fragment elsewhere would re-base
        // TextKit's height estimate under the reader.
        let begin = manager.documentRange.location
        let endShown = manager.offset(from: begin, to: shown.endLocation) >= storage.length
        let startShown = manager.offset(from: begin, to: shown.location) == 0
        let text = storage.string as NSString
        let endsWithBreak = [10, 13].contains(text.character(at: text.length - 1))
        // The last line's start: marked text being composed at its end has no block yet.
        let lastLine = text.paragraphRange(for: NSRange(location: text.length - 1, length: 0))
        let lastIsCode =
            endsWithBreak ? trailingBlock?.code == true : isCode(at: lastLine.location)
        if endShown, lastIsCode, let last = lastFragment() {
            let frame = last.layoutFragmentFrame
            let trailingBottom = last.trailingRowFrame.map { $0.top + $0.height } ?? 0
            let bottom = inset.top + frame.minY + max(frame.height, trailingBottom)
            if p.y > bottom { return .openLineAfterCodeBlock }
        }
        if startShown, isCode(at: 0),
            let first = manager.textLayoutFragment(for: manager.documentRange.location),
            let line = first.textLineFragments.first,
            p.y < inset.top + first.layoutFragmentFrame.minY + line.typographicBounds.minY
        {
            return .openLineBeforeCodeBlock
        }
        return nil
    }

    /// Open the line `edge` names, the caret on it. Marked text is committed first, as for every
    /// tap-driven command, and the block's end is read after it: the commit can change the
    /// display's length (a typed `## ` becomes a hidden heading prefix).
    func openLine(beside edge: EditorBlockCommand) {
        finishComposition()
        let offset = UInt64(edge == .openLineAfterCodeBlock ? storage.length : 0)
        let range = EditorUtf16Range(start: offset, end: offset)
        runCommand("code block edge") { session, expected in
            try session.blockCommandUtf16(expected: expected, range: range, command: edge)
        }
    }

    private func isCode(at offset: Int) -> Bool {
        (storage.attribute(.tfBlock, at: offset, effectiveRange: nil) as? TextFirstBlockAttribute)?
            .code == true
    }
}
