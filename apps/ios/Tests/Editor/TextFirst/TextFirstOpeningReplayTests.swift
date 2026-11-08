#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// Keys typed while a long note opens take UIKit's real key path (`insertText`,
    /// `deleteBackward`, `replace`): the frozen view never changes, the keys wait, and they replay
    /// at the engine's caret in order, as they would have landed on an editor that opened whole.
    /// Only taps are mapped through earlier edits.
    extension TextFirstOpeningTests {
        /// The keys `act` makes on a view whose engine has not landed equal the same keys on an
        /// editor that opened whole: same display, same source, same caret. The view is unchanged
        /// until the engine lands.
        private func expectOpeningMatchesWhole(
            _ source: String, select: NSRange, _ act: (UITextView) -> Void
        ) throws -> Opening {
            let o = try Opening(source)
            o.tv.selectedRange = select
            let shown = o.tv.text
            act(o.tv)
            #expect(o.tv.text == shown, "UIKit changed the frozen view")
            try o.land()
            let h = TextFirstHarness(source, id: "long")
            h.tv.selectedRange = select
            act(h.tv)
            #expect(o.tv.text == h.tv.text)
            #expect(
                try o.controller.session.sourceText() == (try h.controller.session.sourceText()))
            #expect(o.controller.engineSelection == h.controller.engineSelection)
            return o
        }

        private func typed(_ o: Opening, hasPrefix prefix: String) {
            let text = o.tv.text ?? ""
            #expect(text.hasPrefix(prefix), "view starts \(text.prefix(40).debugDescription)")
        }

        @Test func aTypedKeyThenBackspaceWhileOpeningLeavesTheNoteAsItWas() throws {
            let o = try expectOpeningMatchesWhole(
                Self.note(), select: NSRange(location: 9, length: 0)
            ) { tv in
                tv.insertText("x")
                tv.deleteBackward()
            }
            typed(o, hasPrefix: "Section 0\n\nBody line 0")
        }

        @Test func eachBackspaceWhileOpeningDeletesOneCharacter() throws {
            let o = try expectOpeningMatchesWhole(
                Self.note(), select: NSRange(location: 9, length: 0)
            ) { tv in
                tv.deleteBackward()
                tv.deleteBackward()
            }
            typed(o, hasPrefix: "Section\n\nBody line 0")
        }

        @Test func typeBackspaceTypeWhileOpeningKeepsTheLastKey() throws {
            let o = try expectOpeningMatchesWhole(
                Self.note(), select: NSRange(location: 9, length: 0)
            ) { tv in
                tv.insertText("x")
                tv.deleteBackward()
                tv.insertText("y")
            }
            typed(o, hasPrefix: "Section 0y\n\nBody line 0")
        }

        @Test func keysTypedAtTheStartOfARunOfIdenticalCharactersThenATapLandWhereTheFingerWas()
            throws
        {
            // "aa": type "a" at the start, tap between the original two a's, type "b".
            let o = try Opening("aa\n\n" + Self.note())
            o.tv.insertText("a")
            o.tv.selectedRange = NSRange(location: 1, length: 0)
            o.tv.insertText("b")
            try o.land()
            typed(o, hasPrefix: "aaba\n\nSection 0")
        }

        @Test func aBackspaceAfterTypedLettersBesideAnEmojiDeletesOneLetter() throws {
            let o = try expectOpeningMatchesWhole(
                "\u{1F600}\n\n" + Self.note(), select: NSRange(location: 2, length: 0)
            ) { tv in
                tv.insertText("b")
                tv.insertText("a")
                tv.deleteBackward()
            }
            typed(o, hasPrefix: "\u{1F600}b\n\nSection 0")
        }

        @Test func repeatedBackspacesOverAnEmojiAfterALetterDeleteOneCharacterEach() throws {
            let o = try expectOpeningMatchesWhole(
                "ab\u{1F600}\n\n" + Self.note(), select: NSRange(location: 4, length: 0)
            ) { tv in
                tv.deleteBackward()
                tv.deleteBackward()
            }
            typed(o, hasPrefix: "a\n\nSection 0")
        }

        @Test func aTypedEmojiThenBackspaceIsDeleted() throws {
            let o = try expectOpeningMatchesWhole(
                "x\n\n" + Self.note(), select: NSRange(location: 1, length: 0)
            ) { tv in
                tv.insertText("\u{1F600}")
                tv.deleteBackward()
            }
            typed(o, hasPrefix: "x\n\nSection 0")
        }

        @Test func aBackspaceOverACrlfAfterTypingLeavesNoLoneCarriageReturn() throws {
            let source = "ab\r\ncd\r\n\r\n" + Self.note()
            let o = try expectOpeningMatchesWhole(source, select: NSRange(location: 4, length: 0)) {
                tv in
                tv.insertText("x")
                tv.deleteBackward()
            }
            typed(o, hasPrefix: "ab\r\ncd\r\n")
        }

        @Test func aBackspaceAfterTypingOverASelectionDeletesWhatWasTyped() throws {
            let o = try expectOpeningMatchesWhole(
                "hello world\n\n" + Self.note(), select: NSRange(location: 6, length: 5)
            ) { tv in
                tv.insertText("X")
                tv.deleteBackward()
            }
            typed(o, hasPrefix: "hello \n\nSection 0")
        }

        @Test func aTapAtTheStartOfAReplacedSelectionIsACaretNotASelectionOfWhatReplacedIt() throws
        {
            let o = try Opening("hello world\n\n" + Self.note())
            o.tv.selectedRange = NSRange(location: 6, length: 5)
            o.tv.insertText("X")
            o.tv.selectedRange = NSRange(location: 6, length: 0)
            o.tv.insertText("Y")
            try o.land()
            typed(o, hasPrefix: "hello YX\n\nSection 0")
        }

        @Test func anAutocorrectAndMarkedTextWhileOpeningNeverChangeTheFrozenView() throws {
            let o = try Opening("teh\n\n" + Self.note())
            let shown = o.tv.text
            let range = try #require(
                o.tv.textRange(
                    from: o.tv.position(from: o.tv.beginningOfDocument, offset: 0)!,
                    to: o.tv.position(from: o.tv.beginningOfDocument, offset: 3)!))
            o.tv.replace(range, withText: "the")
            o.tv.setMarkedText("ka", selectedRange: NSRange(location: 2, length: 0))
            #expect(o.tv.text == shown)
            #expect(o.tv.markedTextRange == nil)
            try o.land()
            typed(o, hasPrefix: "the\n\nSection 0")
        }
    }
#endif
