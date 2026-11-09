#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A tap on an image selects it as one object (see `selectImage`); where that selection's
    /// caret is drawn is the trailing edge of the image, and nothing about the selection changes.
    @Suite @MainActor
    struct TextFirstImageCaretTests {
        struct Case: CustomTestStringConvertible, Sendable {
            let name: String
            let source: String
            let file: String
            let pixels: (Int, Int)
            var testDescription: String { name }
        }

        static let cases = [
            Case(
                name: "full width, end of note", source: "![](caret-wide.png)",
                file: "caret-wide.png",
                pixels: (1200, 800)),
            Case(
                name: "full width, mid note", source: "one\n\n![](caret-wide.png)\n\ntwo",
                file: "caret-wide.png", pixels: (1200, 800)),
            Case(
                name: "small, end of note", source: "tail ![](caret-small.png)",
                file: "caret-small.png",
                pixels: (180, 120)),
            Case(
                name: "small, mid line", source: "hello ![](caret-small.png) world",
                file: "caret-small.png",
                pixels: (180, 120)),
        ]

        /// The editor with the image drawn, and the image's range and drawn frame (text view coordinates).
        private func open(_ c: Case) async -> (TextFirstHarness, NSRange, CGRect) {
            let h = TextFirstHarness(
                c.source, files: [c.file: TextFirstHarness.png(c.pixels.0, c.pixels.1)])
            let range = (c.source as NSString).range(of: "![](\(c.file))")
            _ = await h.until {
                (h.controller.storage.attribute(.tfImage, at: range.location, effectiveRange: nil)
                    as? TextFirstImageSpan)?.atom.image != nil
            }
            // The decoded bitmap relays the line out; wait for it to settle.
            try? await Task.sleep(nanoseconds: 200_000_000)
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            let at = manager.location(manager.documentRange.location, offsetBy: range.location)!
            let fragment = manager.textLayoutFragment(for: at) as! TextFirstLayoutFragment
            let run = fragment.imageRuns[0]
            let local = fragment.imageRect(run)!
            let inset = h.tv.textContainerInset
            let frame = local.offsetBy(
                dx: inset.left, dy: inset.top + fragment.layoutFragmentFrame.minY)
            return (h, range, frame)
        }

        @Test(arguments: cases) func aTappedImagesCaretIsAtItsTrailingEdge(_ c: Case) async throws {
            let (h, range, frame) = await open(c)
            #expect(h.controller.imageHit(at: CGPoint(x: frame.midX, y: frame.midY)) == range)
            h.tv.selectedRange = range
            // Where the text goes is as it was: the whole image is selected.
            #expect(h.tv.selectedRange == range)
            #expect(h.controller.engineSelection == range)

            let caret = h.tv.caretRect(for: h.tv.selectedTextRange!.end)
            #expect(abs(caret.minX - frame.maxX) <= 2, "\(caret) vs \(frame)")
            #expect(caret.minY >= frame.minY - 0.5 && caret.maxY <= frame.maxY + 0.5)
            #expect(abs(caret.maxY - frame.maxY) <= 1, "bottom-aligned with the image's line")
            #expect(caret.height <= ceil(TextFirstEditorController.bodyFont.lineHeight))

            // UIKit's own selection (a bar and a handle on each edge) is not drawn: one caret is.
            let rects = h.tv.selectionRects(for: h.tv.selectedTextRange!)
            #expect(rects.isEmpty)
            let drawn = try #require(h.tv.imageCaret.isHidden ? nil : h.tv.imageCaret.frame)
            #expect(abs(drawn.minX - frame.maxX) <= 2)
            #expect(drawn.minY >= frame.minY - 0.5 && drawn.maxY <= frame.maxY + 0.5)
            #expect(h.controller.divergences.isEmpty)
        }

        @Test(arguments: cases) func aCaretAfterAnImageIsDrawnAtItsTrailingEdgeToo(_ c: Case) async
        {
            let (h, range, frame) = await open(c)
            h.tv.selectedRange = NSRange(location: NSMaxRange(range), length: 0)
            #expect(h.tv.selectedRange == NSRange(location: NSMaxRange(range), length: 0))
            let caret = h.tv.caretRect(for: h.tv.selectedTextRange!.end)
            #expect(abs(caret.minX - frame.maxX) <= 2, "\(caret) vs \(frame)")
            #expect(abs(caret.maxY - frame.maxY) <= 1)
            #expect(h.tv.imageCaret.isHidden)
        }

        @Test(arguments: cases) func theCaretLeavesTheImageEdgeOnceTextIsTypedAfterIt(_ c: Case)
            async
        {
            let (h, range, frame) = await open(c)
            h.tv.selectedRange = NSRange(location: NSMaxRange(range), length: 0)
            h.type("x")
            // Typed text goes after the image, which stays; the caret is where UIKit puts it.
            let at = (h.display as NSString).range(of: "![](\(c.file))x")
            #expect(at.location != NSNotFound, "\(h.display)")
            #expect(h.tv.selectedRange.length == 0)
            #expect(h.tv.imageCaret.isHidden)
            let caret = h.tv.caretRect(for: h.tv.selectedTextRange!.end)
            let image = (h.display as NSString).range(of: "![](\(c.file))")
            #expect(NSMaxRange(image) + 1 == h.tv.selectedRange.location)
            // Past the typed text (to the right of the image, or on the line it wrapped to).
            #expect(
                caret.minX > frame.maxX + 2 || caret.minY >= frame.maxY - 1, "\(caret) vs \(frame)")
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func movingTheSelectionAwayFromAnImageRemovesItsCaret() async {
            let (h, range, _) = await open(Self.cases[3])
            h.tv.selectedRange = range
            #expect(!h.tv.imageCaret.isHidden)
            h.select(0, 0)
            #expect(h.tv.imageCaret.isHidden)
            // A partial selection that includes the image is UIKit's own.
            h.select(0, NSMaxRange(range))
            #expect(h.tv.imageCaret.isHidden)
        }
    }
#endif
