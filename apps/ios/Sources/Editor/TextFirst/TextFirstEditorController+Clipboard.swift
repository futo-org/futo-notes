#if FUTO_DEBUG_BUILD
    import UIKit

    extension TextFirstEditorController {
        // MARK: clipboard (the engine's Markdown, not the display text)

        func byteRange(_ r: NSRange) throws -> EditorByteRange {
            try session.utf16ToDisplay(expected: rev, range: Self.range(r))
        }

        func copySelection(_ range: NSRange? = nil) {
            let r = range ?? effectiveSelection
            guard r.length > 0, !engineBusy, !engineComposing else { return }
            do {
                UIPasteboard.general.string = try session.copyMarkdown(
                    expected: rev, range: byteRange(r))
            } catch { recover(error, context: "copy") }
        }

        func cutSelection(_ range: NSRange? = nil) {
            let r = range ?? effectiveSelection
            guard r.length > 0, !engineBusy, !engineComposing else { return }
            do {
                let cut = try session.cutMarkdown(expected: rev, range: byteRange(r))
                UIPasteboard.general.string = cut.markdown
                if let change = cut.change { try accept(change) }
            } catch { recover(error, context: "cut") }
        }

        func pasteFromPasteboard(_ range: NSRange? = nil) {
            guard !engineBusy else { return }
            if range == nil, pasteImageFromPasteboard() { return }
            guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
            finishComposition()
            do {
                if let change = try session.pasteMarkdown(
                    expected: rev, range: byteRange(range ?? effectiveSelection), text: text)
                {
                    try accept(change)
                }
            } catch { recover(error, context: "paste") }
        }
    }
#endif
