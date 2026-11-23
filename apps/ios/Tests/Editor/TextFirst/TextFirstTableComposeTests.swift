#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// Marked text and Korean syllables in a table cell's field.
    @Suite @MainActor
    struct TextFirstTableComposeTests {
        static let note = "| a | b |\n|---|---|\n| x | y |\n| p | q |\n"

        /// The hit on the cell whose content is `text` in the note's display.
        private func hit(_ h: TextFirstHarness, _ text: String) throws
            -> TextFirstEditorController
            .TableCellHit
        {
            let at = (h.display as NSString).range(of: "| \(text) |").location + 2
            return try #require(h.controller.tableCellHit(atStart: at))
        }

        /// The cell a tap selected before the open cell committed marked text gets the next key,
        /// and the marked text is in the cell it was composed in.
        @Test func switchingCellsWhileComposingKeepsBothCellsRight() throws {
            for (target, expected) in [
                ("y", "| xni | yz |\n|"),  // right of the cell, in its row
                ("p", "| xni | y |\n| pz |"),  // in the row below
            ] {
                let h = TextFirstHarness(Self.note)
                let targetHit = try hit(h, target)
                h.controller.openCellEditor(try hit(h, "x"))
                let editor = try #require(h.controller.cellEditor)
                _ = editor.textView(
                    editor.field, shouldChangeTextIn: editor.field.selectedRange,
                    replacementText: "n")
                editor.field.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0))
                #expect(h.controller.engineComposing)
                // The hit was taken before the commit, as a tap's is.
                h.controller.openCellEditor(targetHit)
                let opened = try #require(h.controller.cellEditor)
                #expect(opened !== editor)
                opened.field.insertText("z")
                #expect(h.source.contains(expected.prefix(expected.count - 1)))
                #expect(h.controller.divergences.isEmpty)
            }
        }

        /// Korean 2-set announces "insert ㅏ at 1..1" for the key that replaces 간 with 가나: the
        /// same length change as the announced one, a different text.
        @Test func aKoreanSyllableSplitReportsWhatTheFieldHolds() throws {
            let h = TextFirstHarness("| a | b |\n|---|---|\n| 간 | y |\n")
            h.controller.openCellEditor(try hit(h, "간"))
            let editor = try #require(h.controller.cellEditor)
            #expect(
                editor.textView(
                    editor.field, shouldChangeTextIn: NSRange(location: 1, length: 0),
                    replacementText: "ㅏ"))
            editor.field.text = "가나"
            editor.field.selectedRange = NSRange(location: 2, length: 0)
            editor.textViewDidChange(editor.field)
            #expect(h.source.contains("| 가나 | y |"))
            #expect(h.controller.divergences.isEmpty)
        }
    }
#endif
