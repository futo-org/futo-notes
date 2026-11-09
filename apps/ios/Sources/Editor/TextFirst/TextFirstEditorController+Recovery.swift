#if FUTO_DEBUG_BUILD
    import UIKit

    // What happens when the engine refuses or fails a call: the view shows the engine's text again.

    extension TextFirstEditorController {
        /// Throw away the view's text and show the engine's (a failed or refused call left them
        /// unequal, or the engine changed under us).
        func reloadFromEngine(selecting selection: EditorByteRange? = nil) {
            do {
                let display = try session.displayText()
                rev = try session.revision()
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
                    let selected = textView.selectedRange
                    setSelection(
                        NSRange(
                            location: min(selected.location, mirrorLength),
                            length: min(selected.length, max(0, mirrorLength - selected.location))))
                }
            } catch {
                onFailure?(error)
            }
        }

        /// A refused engine call. The view may be ahead of the engine, so show the engine's.
        func recover(_ error: Error, context: String) {
            print("text-first: \(context) failed: \(error)")
            reloadFromEngine()
        }
    }
#endif
