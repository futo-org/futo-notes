#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A plain tap on an image puts a collapsed caret right after it (see `placeCaretAfterImage`);
    /// a long-press, a drag or select-all still select it as one object, and that selection is
    /// drawn as a selection (never as a caret, which looks like the collapsed one and is replaced
    /// by the next keystroke).
    /// A finished tap at a fixed point, fed to the controller's own tap handler.
    final class FinishedTap: UITapGestureRecognizer {
        var point = CGPoint.zero
        override var state: UIGestureRecognizer.State {
            get { .ended }
            set {}
        }
        override func location(in view: UIView?) -> CGPoint { point }
    }

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

        enum Spot: String, CaseIterable, Sendable {
            case centre, left, right
            func point(in frame: CGRect) -> CGPoint {
                let x =
                    switch self {
                    case .centre: frame.midX
                    case .left: frame.minX + frame.width * 0.2
                    case .right: frame.minX + frame.width * 0.8
                    }
                return CGPoint(x: x, y: frame.midY)
            }
        }

        /// A tap on the image at `spot`, then the main loop until the selection has settled.
        private func tap(_ h: TextFirstHarness, _ spot: Spot, _ frame: CGRect, after: Int) async {
            let tap = FinishedTap(target: nil, action: nil)
            tap.point = spot.point(in: frame)
            h.controller.handleTap(tap)
            _ = await h.until(1) { h.tv.selectedRange == NSRange(location: after, length: 0) }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }

        @Test(arguments: cases, Spot.allCases) func aTapOnAnImagePutsACaretAfterIt(
            _ c: Case, _ spot: Spot
        ) async {
            let (h, range, frame) = await open(c)
            let end = NSRange(location: NSMaxRange(range), length: 0)
            await tap(h, spot, frame, after: end.location)
            #expect(h.tv.selectedRange == end)
            #expect(h.controller.engineSelection == end)
            let caret = h.tv.caretRect(for: h.tv.selectedTextRange!.end)
            #expect(abs(caret.minX - frame.maxX) <= 2, "\(caret) vs \(frame)")
            #expect(abs(caret.maxY - frame.maxY) <= 1)
            #expect(h.controller.divergences.isEmpty)
        }

        @Test(arguments: cases, Spot.allCases) func textTypedAfterATapGoesAfterTheImage(
            _ c: Case, _ spot: Spot
        ) async {
            let (h, range, frame) = await open(c)
            let before = h.source
            await tap(h, spot, frame, after: NSMaxRange(range))
            h.type("x")
            let spelling = "![](\(c.file))"
            let expected = (before as NSString).replacingCharacters(
                in: NSRange(location: NSMaxRange(range), length: 0), with: "x")
            #expect(h.source == expected, "\(h.source.debugDescription)")
            #expect(h.source.contains(spelling + "x"))
            #expect(h.controller.divergences.isEmpty)
        }

        @Test(arguments: cases, Spot.allCases) func backspaceAfterATapRemovesTheImageInOneEdit(
            _ c: Case, _ spot: Spot
        ) async {
            let (h, range, frame) = await open(c)
            let before = h.source
            await tap(h, spot, frame, after: NSMaxRange(range))
            #expect(h.tv.selectedRange == NSRange(location: NSMaxRange(range), length: 0))
            h.tv.deleteBackward()
            #expect(!h.source.contains(c.file), "\(h.source.debugDescription)")
            h.tv.undoManager?.undo()
            #expect(h.source == before, "\(h.source.debugDescription)")
            #expect(h.controller.divergences.isEmpty)
        }

        @Test(arguments: cases) func aLongPressOrDragStillSelectsTheImageAsAnObject(_ c: Case)
            async
        {
            let (h, range, _) = await open(c)
            // UIKit's long-press and drag handles land on the image's edges: it stays selected.
            h.tv.selectedRange = range
            #expect(h.tv.selectedRange == range)
            // A drag across it and select-all keep it inside the selection.
            let all = NSRange(location: 0, length: (h.tv.text as NSString).length)
            h.tv.selectedRange = all
            #expect(h.tv.selectedRange == all)
            h.tv.deleteBackward()
            #expect(!h.source.contains(c.file), "\(h.source.debugDescription)")
        }

        @Test(arguments: cases) func aWholeImageSelectionIsDrawnAsASelection(_ c: Case) async {
            let (h, range, frame) = await open(c)
            h.tv.selectedRange = NSRange(location: NSMaxRange(range), length: 0)
            let collapsed = h.tv.caretRect(for: h.tv.selectedTextRange!.end)
            #expect(abs(collapsed.minX - frame.maxX) <= 2, "\(collapsed) vs \(frame)")

            // Selected as an object (a long-press, say): the whole image is selected.
            h.tv.selectedRange = range
            h.tv.layoutIfNeeded()
            #expect(h.tv.selectedRange == range)
            #expect(h.controller.engineSelection == range)
            // Something is highlighted, over the image: it does not look like the collapsed caret.
            let rects = h.tv.selectionRects(for: h.tv.selectedTextRange!).map(\.rect)
            #expect(!rects.isEmpty)
            let covered = rects.reduce(CGRect.null) { $0.union($1) }
            #expect(covered.width >= frame.width * 0.9, "\(covered) vs \(frame)")
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
            let caret = h.tv.caretRect(for: h.tv.selectedTextRange!.end)
            let image = (h.display as NSString).range(of: "![](\(c.file))")
            #expect(NSMaxRange(image) + 1 == h.tv.selectedRange.location)
            // Past the typed text (to the right of the image, or on the line it wrapped to).
            #expect(
                caret.minX > frame.maxX + 2 || caret.minY >= frame.maxY - 1, "\(caret) vs \(frame)")
            #expect(h.controller.divergences.isEmpty)
        }

        @Test(arguments: cases) func markedTextAfterATapOnAnImageIsDrawnAsBodyText(
            _ c: Case
        ) async throws {
            let (h, range, frame) = await open(c)
            await tap(h, .centre, frame, after: NSMaxRange(range))
            #expect(h.tv.selectedRange == NSRange(location: NSMaxRange(range), length: 0))
            h.tv.setMarkedText("\u{3042}", selectedRange: NSRange(location: 1, length: 0))
            let marked = try #require(h.tv.markedTextRange)
            let at = h.tv.offset(from: h.tv.beginningOfDocument, to: marked.start)
            let drawn = h.controller.storage.attributes(at: at, effectiveRange: nil)
            let font = drawn[.font] as? UIFont
            #expect(font?.pointSize == TextFirstEditorController.bodyFont.pointSize)
            #expect((drawn[.foregroundColor] as? UIColor) == UIColor.label)
            #expect(drawn[.kern] == nil)
            h.tv.unmarkText()
            #expect(h.source.contains("![](\(c.file))\u{3042}"), "\(h.source.debugDescription)")
            #expect(h.controller.divergences.isEmpty)
        }
    }
#endif
