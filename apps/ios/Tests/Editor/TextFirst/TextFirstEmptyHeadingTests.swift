#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The typing attributes of a heading's line: an empty heading on the note's last line, the
    /// caret at the very end of the text, and the first characters typed into a heading.
    @Suite @MainActor
    struct TextFirstEmptyHeadingTests {
        private func typing(_ h: TextFirstHarness) -> UIFont {
            (h.tv.typingAttributes[.font] as? UIFont) ?? TextFirstEditorController.bodyFont
        }

        private func isBold(_ font: UIFont) -> Bool {
            font.fontDescriptor.symbolicTraits.contains(.traitBold)
        }

        private func font(_ h: TextFirstHarness, at index: Int) -> UIFont {
            h.controller.storage.attribute(.font, at: index, effectiveRange: nil) as! UIFont
        }

        private var length: (TextFirstHarness) -> Int { { ($0.tv.text as NSString).length } }

        private func ready(_ source: String) -> TextFirstHarness {
            let h = TextFirstHarness(source)
            h.controller.installToolbar(localization: Localization.system())
            h.select(length(h), length(h))
            return h
        }

        private func expectBody(_ h: TextFirstHarness, _ label: String) {
            #expect(typing(h).pointSize == 17, "\(label): \(typing(h))")
            #expect(!isBold(typing(h)), "\(label): bold")
            #expect(h.controller.divergences.isEmpty, "\(label): \(h.controller.divergences)")
        }

        // NSString.lineRange ends a line at U+2028, U+2029 and U+0085 as well as at a line feed;
        // with the caret at the end of the text just after one, its line is the empty last line.
        @Test(arguments: ["\u{2028}", "\u{2029}", "\u{0085}"])
        func aSeparatorTypedAtTheEndOfTheNoteTypesBody(separator: String) {
            let h = ready("abc")
            h.type(separator)
            expectBody(h, "separator \(separator.unicodeScalars.first!.value)")
        }

        @Test func aPastedSeparatorAtTheEndOfTheNoteTypesBody() {
            let h = ready("abc")
            UIPasteboard.general.string = "pasted\u{2028}"
            h.controller.pasteFromPasteboard()
            expectBody(h, "paste")
        }

        @Test(arguments: ["", "abc\n", "abc\n\n"])
        func theCaretAtTheEndOfTheTextOnAnEmptyLineTypesBody(source: String) {
            let h = ready(source)
            expectBody(h, "\(source.debugDescription)")
        }

        // The empty line keeps the container's indents: the caret sits where the typed line will.
        // A quote is the one container a heading sits in (`- # x` is a bullet holding "# x").
        @Test(arguments: ["> "])
        func anEmptyHeadingInAContainerKeepsItsIndentOnTheFirstKeystroke(prefix: String) {
            let h = ready("abc\n")
            h.type(prefix)
            h.type("# ")
            let before = h.tv.typingAttributes[.paragraphStyle] as? NSParagraphStyle
            h.type("H")
            let last = length(h) - 1
            let after =
                h.controller.storage.attribute(.paragraphStyle, at: last, effectiveRange: nil)
                as? NSParagraphStyle
            #expect((before?.headIndent ?? -1) > 0, "\(prefix): caret indent \(before as Any)")
            #expect(before?.headIndent == after?.headIndent, "\(prefix): head indent")
            #expect(
                before?.firstLineHeadIndent == after?.firstLineHeadIndent, "\(prefix): first line")
            #expect(font(h, at: last).pointSize == 28, "\(prefix): still a heading")
            #expect(h.controller.divergences.isEmpty)
        }

        // Once the heading has a character the empty last line is gone, but the caret is still in
        // the heading: the next character, or a composition, starts as the heading's.
        @Test(arguments: [1, 4])
        func typingAfterTheFirstCharacterOfAnEmptyHeadingStaysAHeading(level: Int) {
            let size = TextFirstStyler.headingSizes[level - 1]
            let marker = String(repeating: "#", count: level)
            let h = ready("abc\n")
            h.type("\(marker) ")
            h.type("H")
            #expect(typing(h).pointSize == size, "level \(level): size \(typing(h))")
            #expect(isBold(typing(h)), "level \(level): bold")
            h.tv.setMarkedText("\u{306B}", selectedRange: NSRange(location: 1, length: 0))
            let marked = length(h) - 1
            #expect(font(h, at: marked).pointSize == size, "level \(level): marked size")
            #expect(isBold(font(h, at: marked)), "level \(level): marked bold")
            h.tv.unmarkText()
            #expect(h.controller.divergences.isEmpty, "\(h.controller.divergences)")
        }
    }
#endif
