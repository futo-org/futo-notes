#if FUTO_DEBUG_BUILD
    import UIKit

    /// Draws the engine's style plan onto the text storage. Every span says what the engine
    /// decided (heading level, inline formats, quote depth); nothing here parses Markdown.
    /// Lists, checkboxes, dividers and quote bars are M3; links' taps are M4.
    @MainActor
    enum TextFirstStyler {
        static let headingSizes: [CGFloat] = [28, 24, 21, 19, 17, 16]
        static var mono: UIFont { .monospacedSystemFont(ofSize: 15, weight: .regular) }

        /// Reset `window` to the base look, then apply `specs` (spans of the whole display).
        static func apply(_ specs: [EditorStyleSpan], to storage: NSTextStorage, window: NSRange) {
            let length = storage.length
            guard window.location < length else { return }
            let window = NSRange(
                location: window.location, length: min(window.length, length - window.location))
            storage.beginEditing()
            storage.setAttributes(TextFirstEditorController.baseAttributes, range: window)
            for spec in specs { apply(spec, to: storage, length: length) }
            storage.endEditing()
        }

        private static func range(_ start: UInt64, _ end: UInt64, _ length: Int) -> NSRange? {
            let s = Int(start)
            let e = min(Int(end), length)
            return s < e ? NSRange(location: s, length: e - s) : nil
        }

        private static func apply(_ spec: EditorStyleSpan, to storage: NSTextStorage, length: Int) {
            switch spec {
            case .heading(let start, let end, let level):
                guard let r = range(start, end, length) else { return }
                let size = headingSizes[min(max(Int(level), 1), 6) - 1]
                storage.addAttribute(.font, value: UIFont.systemFont(ofSize: size, weight: .bold), range: r)
                let paragraph = NSMutableParagraphStyle()
                paragraph.lineSpacing = 4
                paragraph.paragraphSpacingBefore = level <= 2 ? 6 : 2
                storage.addAttribute(.paragraphStyle, value: paragraph, range: r)
            case .quote(let start, let end, let depth):
                guard let r = range(start, end, length) else { return }
                let indent = 14 + CGFloat(max(Int(depth), 1) - 1) * 14
                let paragraph = NSMutableParagraphStyle()
                paragraph.lineSpacing = 4
                paragraph.firstLineHeadIndent = indent
                paragraph.headIndent = indent
                storage.addAttributes(
                    [.paragraphStyle: paragraph, .foregroundColor: UIColor.secondaryLabel], range: r)
            case .code(let start, let end), .metadata(let start, let end):
                guard let r = range(start, end, length) else { return }
                storage.addAttributes(
                    [.font: mono, .backgroundColor: UIColor.tertiarySystemFill], range: r)
            case .inline(let start, let end, let bold, let italic, let strike, let code):
                guard let r = range(start, end, length) else { return }
                if bold || italic || code { restyleFont(storage, r, bold, italic, code) }
                if strike {
                    storage.addAttribute(
                        .strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: r)
                }
                if code { storage.addAttribute(.backgroundColor, value: UIColor.tertiarySystemFill, range: r) }
            case .link(let start, let end, _):
                guard let r = range(start, end, length) else { return }
                storage.addAttributes(
                    [
                        .foregroundColor: UIColor(Theme.primary),
                        .underlineStyle: NSUnderlineStyle.single.rawValue,
                    ], range: r)
            case .wikilink(let start, let end, _, let noteId):
                guard let r = range(start, end, length) else { return }
                storage.addAttribute(
                    .foregroundColor, value: noteId == nil ? UIColor.secondaryLabel : UIColor(Theme.primary),
                    range: r)
            case .listRow, .divider:
                break
            }
        }

        private static func restyleFont(
            _ storage: NSTextStorage, _ r: NSRange, _ bold: Bool, _ italic: Bool, _ code: Bool
        ) {
            storage.enumerateAttribute(.font, in: r) { value, sub, _ in
                let old = (value as? UIFont) ?? TextFirstEditorController.bodyFont
                var traits = old.fontDescriptor.symbolicTraits
                if bold { traits.insert(.traitBold) }
                if italic { traits.insert(.traitItalic) }
                var base = old
                if code { base = .monospacedSystemFont(ofSize: old.pointSize - 2, weight: .regular) }
                let descriptor = base.fontDescriptor.withSymbolicTraits(traits) ?? base.fontDescriptor
                storage.addAttribute(.font, value: UIFont(descriptor: descriptor, size: base.pointSize), range: sub)
            }
        }
    }
#endif
