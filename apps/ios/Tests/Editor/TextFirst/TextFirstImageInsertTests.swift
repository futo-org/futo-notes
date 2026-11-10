#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct TextFirstImageInsertTests {
        // The picker inserts the reference first and the bitmap decodes later: the finished load
        // alone must resize the image's line, with no further edit or caret move. An image put at
        // the very end of the text (an empty last line, or no trailing line ending) starts exactly
        // where the styled prefix ends, so that is where the load's re-layout used to miss it.
        @Test(arguments: [
            ("one two\n\nz", 8), ("one two\n", 7), ("one two\n", 8), ("one two", 7),
            ("one two\n\n", 9), ("", 0),
        ])
        func aJustInsertedImageIsLaidOutAtItsSizeWithoutAnotherEditOrCaretMove(
            source: String, caret: Int
        ) async throws {
            let h = TextFirstHarness(source)
            h.select(caret, caret)
            let claim = try #require(h.controller.beginImageInsertion())
            // What the picker does after `VaultImages.save`; a unique name keeps the process-wide
            // bitmap cache (keyed by file name, and the saved names are per second) from answering.
            let name = "inserted-\(UUID().uuidString).png"
            try TextFirstHarness.png(900, 450).write(to: h.root.appendingPathComponent(name))
            #expect(h.controller.insertSavedImage(filename: name, claim: claim))
            let storage = h.controller.storage
            var found: (run: NSRange, span: TextFirstImageSpan)?
            storage.enumerateAttribute(.tfImage, in: NSRange(location: 0, length: storage.length)) {
                value, run, _ in
                if let span = value as? TextFirstImageSpan { found = (run, span) }
            }
            let (run, span) = try #require(found)
            #expect(span.atom.image == nil)
            #expect(await h.until { span.atom.image != nil })
            let size = TextFirstImageMetrics.size(
                of: span.atom, available: h.controller.images.containerWidth)
            #expect(size.height > TextFirstImageMetrics.loadingHeight, "\(size)")
            let selection = h.tv.selectedRange
            func lineHeight() -> CGFloat {
                (storage.attribute(.paragraphStyle, at: run.location, effectiveRange: nil)
                    as? NSParagraphStyle)?.minimumLineHeight ?? 0
            }
            #expect(
                await h.until { lineHeight() == size.height },
                "line \(lineHeight()) not \(size.height)")
            #expect(h.tv.selectedRange == selection)
            #expect(h.controller.divergences.isEmpty)
        }
    }
#endif
