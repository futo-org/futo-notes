#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// Keys typed while a long note opens replay at the engine's caret, in order, as they would
    /// have landed on an editor that opened whole; only taps are mapped through earlier edits.
    extension TextFirstOpeningTests {
        /// A Backspace the way UIKit asks the delegate for it (the unit before the caret) on a view
        /// that takes no change.
        private func backspace(_ tv: UITextView) {
            let caret = tv.selectedRange.location
            _ = tv.delegate?.textView?(
                tv, shouldChangeTextIn: NSRange(location: caret - 1, length: 1),
                replacementText: "")
        }

        /// The keys `act` makes on a view whose engine has not landed equal the same keys on an
        /// editor that opened whole: same display, same source, same caret.
        private func expectOpeningMatchesWhole(
            _ source: String, caret: Int, _ act: (UITextView, (String) -> Void, () -> Void) -> Void
        ) throws {
            let o = try Opening(source)
            o.tv.selectedRange = NSRange(location: caret, length: 0)
            act(o.tv, { o.type($0) }, { self.backspace(o.tv) })
            try o.land()
            let h = TextFirstHarness(source, id: "long")
            h.tv.selectedRange = NSRange(location: caret, length: 0)
            act(h.tv, { h.type($0) }, { h.tv.deleteBackward() })
            #expect(o.tv.text == h.tv.text)
            #expect(
                try o.controller.session.sourceText() == (try h.controller.session.sourceText()))
            #expect(o.controller.engineSelection == h.controller.engineSelection)
        }

        @Test func aTypedKeyThenBackspaceWhileOpeningLeavesTheNoteAsItWas() throws {
            let source = Self.note()
            try expectOpeningMatchesWhole(source, caret: 9) { _, type, back in
                type("x")
                back()
            }
            // And the note is what it was (the typed key was deleted, not the character before it).
            let o = try Opening(source)
            o.tv.selectedRange = NSRange(location: 9, length: 0)
            o.type("x")
            backspace(o.tv)
            try o.land()
            #expect((o.tv.text ?? "").hasPrefix("Section 0\n\nBody line 0"))
        }

        @Test func eachBackspaceWhileOpeningDeletesOneCharacter() throws {
            try expectOpeningMatchesWhole(Self.note(), caret: 9) { _, _, back in
                back()
                back()
                back()
            }
            let o = try Opening(Self.note())
            o.tv.selectedRange = NSRange(location: 9, length: 0)
            backspace(o.tv)
            backspace(o.tv)
            try o.land()
            #expect((o.tv.text ?? "").hasPrefix("Section\n\nBody line 0"))
        }

        @Test func typeBackspaceTypeWhileOpeningKeepsTheLastKey() throws {
            let source = Self.note()
            try expectOpeningMatchesWhole(source, caret: 9) { _, type, back in
                type("x")
                back()
                type("y")
            }
            let o = try Opening(source)
            o.tv.selectedRange = NSRange(location: 9, length: 0)
            o.type("x")
            backspace(o.tv)
            o.type("y")
            try o.land()
            #expect((o.tv.text ?? "").hasPrefix("Section 0y\n\nBody line 0"))
        }

        @Test func keysTypedAtTheStartOfARunOfIdenticalCharactersThenATapLandWhereTheFingerWas()
            throws
        {
            // "aa": type "a" at the start, tap between the original two a's, type "b".
            let source = "aa\n\n" + Self.note()
            let o = try Opening(source)
            o.tv.selectedRange = NSRange(location: 0, length: 0)
            o.type("a")
            o.tv.selectedRange = NSRange(location: 1, length: 0)
            o.type("b")
            try o.land()
            #expect((o.tv.text ?? "").hasPrefix("aaba\n\nSection 0"))
        }
    }
#endif
