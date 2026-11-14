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
            let text = try selectionMarkdown(r)
            UIPasteboard.general.string = text
            #if DEBUG
                PuppetNativeEditor.shared.recordCopy(text)
            #endif
        } catch { recover(error, context: "copy") }
    }

    func cutSelection(_ range: NSRange? = nil) {
        let r = range ?? effectiveSelection
        guard r.length > 0, !engineBusy, !engineComposing else { return }
        do {
            let text = try cutMarkdown(r)
            UIPasteboard.general.string = text
            #if DEBUG
                PuppetNativeEditor.shared.recordCopy(text)
            #endif
        } catch { recover(error, context: "cut") }
    }

    func pasteFromPasteboard(_ range: NSRange? = nil) {
        guard !engineBusy else { return }
        if range == nil, pasteImageFromPasteboard() { return }
        guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
        do {
            try pasteMarkdown(text, range: range)
        } catch { recover(error, context: "paste") }
    }

    /// Shared command orchestration; the system clipboard and the debug driver's private
    /// clipboard choose their own transport without duplicating the engine action.
    func selectionMarkdown(_ range: NSRange) throws -> String {
        try session.copyMarkdown(expected: rev, range: byteRange(range))
    }

    func cutMarkdown(_ range: NSRange) throws -> String {
        let cut = try session.cutMarkdown(expected: rev, range: byteRange(range))
        if let change = cut.change { try accept(change) }
        return cut.markdown
    }

    func pasteMarkdown(_ text: String, range: NSRange? = nil) throws {
        finishComposition()
        if let change = try session.pasteMarkdown(
            expected: rev, range: byteRange(range ?? effectiveSelection), text: text)
        {
            try accept(change)
        }
    }

}
