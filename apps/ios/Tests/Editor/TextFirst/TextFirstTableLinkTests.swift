#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The Link prompt's commit from inside a table cell.
    @Suite @MainActor
    struct TextFirstTableLinkTests {
        /// A cell displays `a|b` for the source `a\\|b`: the prompt's label is that text, and
        /// committing it unchanged keeps the label's bold.
        @Test func editingOnlyTheUrlOfABoldCellLinkWithAnEscapedPipeKeepsItsLabel() throws {
            let h = TextFirstHarness("| [**a\\|b**](http://x.com) | z |\n|---|---|\n")
            let at = (h.display as NSString).range(of: "a|b").location
            h.controller.openCellEditor(try #require(h.controller.tableCellHit(atStart: at)))
            #expect(h.controller.cellOpen)
            let session = h.controller.session
            let selection = h.controller.engineSelection
            let bytes = try session.utf16ToDisplay(
                expected: h.controller.rev,
                range: EditorUtf16Range(
                    start: UInt64(selection.location), end: UInt64(NSMaxRange(selection))))
            let link = try #require(
                try session.inspectLink(expected: h.controller.rev, range: bytes))
            let from = try h.controller.mirror.byteToUtf16(byte: link.range.start)
            let to = try h.controller.mirror.byteToUtf16(byte: link.range.end)
            let label = try h.controller.mirror.sliceUtf16(start: from, end: to)
            #expect(label == "a|b")
            h.controller.commitLink(
                revision: h.controller.rev, range: link.range, label: label,
                destination: "http://x.comx")
            #expect(h.source.hasPrefix("| [**a\\|b**](http://x.comx) | z |"))
        }
    }
#endif
