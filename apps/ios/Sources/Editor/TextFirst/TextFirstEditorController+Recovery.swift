import UIKit

// What happens when the engine refuses or fails a call: the view shows the engine's text again.

extension TextFirstEditorController {
    /// Throw away the view's text and show the engine's (a failed or refused call left them
    /// unequal, or the engine changed under us).
    func reloadFromEngine(selecting selection: EditorByteRange? = nil) {
        do {
            try endEngineComposition()
            let display = try session.displayText()
            mirror.reset(display: display)
            mirrorLength = display.utf16.count
            engineComposing = false
            pendingEdit = nil
            applying += 1
            textView.unmarkText()
            storage.setAttributedString(
                NSAttributedString(string: display, attributes: Self.baseAttributes))
            applying -= 1
            styledThrough = 0
            styleFirstScreen()
            if let selection {
                let start = try mirror.byteToUtf16(byte: selection.start)
                let end = try mirror.byteToUtf16(byte: selection.end)
                setSelection(NSRange(location: Int(start), length: Int(end - start)))
            } else {
                let selected = effectiveSelection
                setSelection(
                    NSRange(
                        location: min(selected.location, mirrorLength),
                        length: min(selected.length, max(0, mirrorLength - selected.location))))
                tellEngineTheShownSelection()
            }
        } catch {
            onFailure?(error)
        }
    }

    /// The view's marked text is about to be dropped; the engine's composition goes with it,
    /// or every later input would be taken as committing it (and refused with it).
    private func endEngineComposition() throws {
        rev = try session.revision()
        if (try? session.composition()) != nil {
            try? session.cancelComposition(expected: rev)
        }
    }

    /// A refused engine call. The view may be ahead of the engine, so show the engine's text,
    /// and its selection: the call changed neither, and the view's selection is wherever the
    /// dropped edit left it (it can fall inside a character).
    func recover(_ error: Error, context: String) {
        print("text-first: \(context) failed: \(error)")
        if verifyDivergence { recoveries.append("\(context): \(error)") }
        let known = engineSelectionRev
        let selection: EditorByteRange? = {
            guard (try? endEngineComposition()) != nil, rev == known else { return nil }
            return try? session.utf16ToDisplay(
                expected: rev, range: Self.range(engineSelection))
        }()
        reloadFromEngine(selecting: selection)
    }

    /// The reload kept the view's selection, which the engine may not share: move the engine's
    /// there, at character boundaries, so a command acts where the view shows. (A selection the
    /// engine gave is not sent back: re-selecting would drop a format armed at the caret.)
    private func tellEngineTheShownSelection() {
        let text = storage.string as NSString
        let shown = engineSelection
        func stop(_ p: Int) -> Int {
            p < text.length ? text.rangeOfComposedCharacterSequence(at: p).location : p
        }
        let start = stop(shown.location)
        let end = max(start, stop(NSMaxRange(shown)))
        guard
            let change = try? session.selectUtf16(
                expected: rev,
                range: EditorUtf16Range(start: UInt64(start), end: UInt64(end))),
            let a = try? mirror.byteToUtf16(byte: change.selection.start),
            let b = try? mirror.byteToUtf16(byte: change.selection.end)
        else { return }
        rev = change.revision
        setSelection(NSRange(location: Int(a), length: Int(b - a)))
    }
}
