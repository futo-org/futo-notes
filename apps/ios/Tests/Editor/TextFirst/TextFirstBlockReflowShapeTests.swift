#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The block drag's live preview on notes of unusual shape (#449, !719 review): a row a
    /// photo far taller than the screen keeps, a quote too long to lay out whole, a line TextKit
    /// splits where the engine does not, and the empty last task carried away.
    @Suite @MainActor
    struct TextFirstBlockReflowShapeTests {
        private static let lines = (0..<300).map { "line \($0)" }.joined(separator: "\n")

        @Test func aRowLeftBesideAPhotoTallerThanTheScreenIsDrawnOnlyWhereItCanShow()
            async throws
        {
            let h = TextFirstHarness(
                "![](tall.png)![](icon.png)\n" + Self.lines,
                files: [
                    "tall.png": TextFirstHarness.png(30, 6000),
                    "icon.png": TextFirstHarness.png(60, 60),
                ], focused: false)
            #expect(await h.until { h.lineHeights(at: 0).contains { $0 > 2000 } })
            let icon = (h.display as NSString).range(of: "![](icon.png)")
            var laidOut = try #require(h.controller.laidOutRange())
            var rect = try #require(h.controller.drawnImage(icon, in: laidOut))
            // The icon sits at the foot of the tall photo's row: scrolled to it.
            h.tv.contentOffset.y = rect.midY - h.tv.bounds.height / 2
            h.tv.layoutIfNeeded()
            laidOut = try #require(h.controller.laidOutRange())
            rect = try #require(h.controller.drawnImage(icon, in: laidOut))
            let drag = try begin(h, at: CGPoint(x: rect.midX, y: rect.midY))
            #expect(drag.lift.block == icon)
            // Down past the line below the row: the row closes up, drawn without the icon.
            drag.follow(CGPoint(x: 60, y: rect.maxY + 2 * 24.3))
            let preview = try #require(drag.preview)
            #expect(preview.isOpen && preview.plan.closing != nil)
            // At most a screen either side of what shows (the row is about 2,000 pt tall).
            let limit = 2.5 * h.tv.bounds.height * TextFirstSlicePainter(textView: h.tv).scale
            #expect(CGFloat(preview.tallestSlice) <= limit, "\(preview.tallestSlice) rows")
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aLongQuoteIsDrawnApartWhereverTheCopyNeedsIt() throws {
            // Short rows first, then rows ten times as long that still fit one line: the
            // estimate from the first stretch puts the later text far too low.
            let short = (0..<11_000).map { _ in "> a" }
            let long = (0..<1_500).map { "> \($0) a quote line that fits one row" }
            let h = TextFirstHarness(
                "intro\n" + (short + long).joined(separator: "\n") + "\nafter", focused: false)
            let p = h.point(line: 1)
            #expect(h.controller.liftShouldBegin(at: p))
            let block = try #require(h.controller.pendingLift?.block)
            #expect(block.length > TextFirstBlockLayout.whole, "\(block.length)")
            let layout = try #require(
                TextFirstBlockLayout(
                    h.controller.storage, block: block, width: h.tv.textContainer.size.width,
                    drawing: 0, host: h.controller))
            #expect(!layout.exact)
            // A screen's stretch near its foot, as the estimate places it: drawn with text in
            // every part of it, or not at all.
            let painter = TextFirstSlicePainter(textView: h.tv)
            let top = painter.pixel(layout.height * 0.97)
            let rect = CGRect(x: 0, y: top, width: h.tv.bounds.width, height: 600)
            if let image = layout.paint(rect, blockTop: 0, with: painter) {
                let box = TextFirstBlockReflowTests.ink(image, rows: 0..<600)
                #expect(box[1] - box[0] > Int(0.9 * 600 * painter.scale), "\(box)")
            }
        }

        @Test func aLineWithAReturnInsideClosesUpWholeWithoutItsPhoto() async throws {
            // A lone return starts a TextKit paragraph inside the note's line.
            let h = TextFirstHarness(
                "caption\rkeep ![](pic.png)\nafter\nmore",
                files: ["pic.png": TextFirstHarness.png(600, 300)], focused: false)
            let photo = (h.display as NSString).range(of: "![](pic.png)")
            #expect(await h.until { h.lineHeights(at: photo.location).contains { $0 > 60 } })
            let laidOut = try #require(h.controller.laidOutRange())
            let rect = try #require(h.controller.drawnImage(photo, in: laidOut))
            let drag = try begin(h, at: CGPoint(x: rect.midX, y: rect.midY))
            drag.follow(h.point(line: 2))
            let closing = try #require(drag.preview?.plan.closing)
            // The same line with no photo, laid out in a note, a line above it as here.
            let alone = TextFirstHarness("first\ncaption\rkeep \nafter", focused: false)
            let height = alone.point(line: 2, fraction: 0).y - alone.point(line: 1, fraction: 0).y
            #expect(
                abs(closing.closed - height) < 1, "closed \(closing.closed), the line \(height)")
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func anEmptyLastTaskCarriedAwayKeepsItsCopyWhenTheWidthChanges() async throws {
            let lines = (0..<120).map { "line \($0)" }
            let h = TextFirstHarness(
                (lines + ["- [ ] milk", "- [ ] "]).joined(separator: "\n"), focused: false)
            h.tv.contentOffset.y = h.tv.contentSize.height - h.tv.bounds.height
            h.tv.layoutIfNeeded()
            let length = h.controller.storage.length
            // The task's row, below `milk`'s: where a press lifts it.
            let milk = h.point(line: 120)
            let row = try #require(
                stride(from: milk.y, to: milk.y + 60, by: 2).first {
                    h.controller.liftPlan(at: CGPoint(x: 120, y: $0))?.block.length == 0
                })
            let drag = try begin(h, at: CGPoint(x: 120, y: row))
            #expect(drag.lift.block == NSRange(location: length, length: 0))
            hold(h, at: 30)
            let from = h.tv.contentOffset.y
            #expect(await h.until(4) { h.tv.contentOffset.y < from - 2 * h.tv.bounds.height })
            hold(h, at: h.tv.bounds.height / 2)
            let preview = try #require(drag.preview)
            for view in [h.window, h.tv] as [UIView] { view.frame.size.width = 300 }
            h.tv.layoutIfNeeded()
            h.controller.remeasureBlockDrag()
            let copy = try #require(preview.copyDrawing, "the copy is drawn again")
            // Not blank: the task's box is drawn.
            let format = UIGraphicsImageRendererFormat()
            (format.scale, format.opaque) = (1, true)
            let blank = UIGraphicsImageRenderer(
                size: CGSize(width: copy.width, height: copy.height), format: format
            ).image { context in
                TextFirstSlicePainter(textView: h.tv).surface.setFill()
                context.fill(CGRect(x: 0, y: 0, width: copy.width, height: copy.height))
            }.cgImage!
            #expect(TextFirstBlockReflowTests.differing(copy, blank) > 50, "the task's box shows")
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aPhotoLiftedFromACRLFLineLeavesItsCaptionOneLineTall() async throws {
            let h = TextFirstHarness(
                "first\r\ncaption ![](pic.png)\r\nafter\r\nmore",
                files: ["pic.png": TextFirstHarness.png(600, 300)], focused: false)
            let photo = (h.display as NSString).range(of: "![](pic.png)")
            #expect(await h.until { h.lineHeights(at: photo.location).contains { $0 > 60 } })
            let laidOut = try #require(h.controller.laidOutRange())
            let rect = try #require(h.controller.drawnImage(photo, in: laidOut))
            let drag = try begin(h, at: CGPoint(x: rect.midX, y: rect.midY))
            drag.follow(h.point(line: 3))
            let closing = try #require(drag.preview?.plan.closing)
            let alone = TextFirstHarness("first\r\ncaption \r\nafter", focused: false)
            let height = alone.point(line: 2, fraction: 0).y - alone.point(line: 1, fraction: 0).y
            #expect(
                abs(closing.closed - height) < 1, "closed \(closing.closed), the line \(height)")
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aCRLFLineLaidOutApartIsAsTallAsInTheNote() throws {
            let h = TextFirstHarness("first\r\nmiddle line\r\nlast\r\nend", focused: false)
            let starts = h.lineStarts
            let layout = try #require(
                TextFirstBlockLayout(
                    h.controller.storage,
                    block: NSRange(location: starts[1], length: starts[2] - starts[1]),
                    width: h.tv.textContainer.size.width, drawing: 0, host: h.controller))
            let live = h.point(line: 2, fraction: 0).y - h.point(line: 1, fraction: 0).y
            #expect(layout.exact && abs(layout.height - live) < 0.5, "\(layout.height) vs \(live)")
        }

        @Test func aCRLFNoteLandsAsThePreviewShowedIt() async throws {
            let h = TextFirstHarness("one\r\ntwo\r\nthree\r\nfour", focused: false)
            let drag = try begin(h, at: h.point(line: 0))
            drag.follow(h.point(line: 2, fraction: 0.6))
            let preview = try #require(drag.preview)
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source == "two\r\nthree\r\none\r\nfour")
            let settled = TextFirstBlockReflowTests.image(preview.curtain.layer, h)
            #expect(await h.until(1) { preview.curtain.superview == nil })
            let real = TextFirstBlockReflowTests.screen(h)
            let differing = TextFirstBlockReflowTests.differing(settled, real)
            #expect(
                differing == 0,
                "\(differing) pixels differ \(TextFirstBlockReflowTests.keep(settled, real, "crlf"))"
            )
        }

        @Test func aBlockAboveAnEmptyLastTaskIsLaidOutApartWithoutItsRow() throws {
            let h = TextFirstHarness("first\ncaption\n- [ ] ", focused: false)
            let lift = try #require(h.controller.liftPlan(at: h.point(line: 1)))
            let block = lift.block
            #expect(NSMaxRange(block) == h.controller.storage.length, "it ends above the task")
            let layout = try #require(
                TextFirstBlockLayout(
                    h.controller.storage, block: block, width: h.tv.textContainer.size.width,
                    drawing: 0, host: h.controller))
            let laidOut = try #require(h.controller.laidOutRange())
            let top = try #require(
                h.controller.boundaryY(
                    TextFirstBlockSlot(offset: block.location, end: false), in: laidOut))
            let foot = try #require(
                h.controller.boundaryY(
                    TextFirstBlockSlot(offset: NSMaxRange(block), end: false), in: laidOut))
            #expect(abs(layout.height - (foot - top)) < 0.5, "\(layout.height) vs \(foot - top)")
        }

        @Test func aPhotoLeftBesideALiftedOneIsDrawnWhereItShows() async throws {
            let h = TextFirstHarness(
                "![](tall.png)![](icon.png)\nnext\nmore\n" + Self.lines,
                files: [
                    "tall.png": Self.bands(30, 6000), "icon.png": TextFirstHarness.png(300, 600),
                ],
                focused: false)
            #expect(await h.until { h.lineHeights(at: 0).contains { $0 > 1500 } })
            let icon = (h.display as NSString).range(of: "![](icon.png)")
            let first = try #require(h.controller.laidOutRange())
            var rect = try #require(h.controller.drawnImage(icon, in: first))
            // At the photos' shared foot, the tall one's top far above the screen: below the
            // lifted photo's middle the row is drawn closed, from the surviving photo's foot.
            h.tv.contentOffset.y = rect.maxY - h.tv.bounds.height / 2
            h.tv.layoutIfNeeded()
            let second = try #require(h.controller.laidOutRange())
            rect = try #require(h.controller.drawnImage(icon, in: second))
            let drag = try begin(h, at: CGPoint(x: rect.midX, y: rect.midY))
            drag.follow(CGPoint(x: 60, y: rect.maxY + 1.6 * 24.3))
            let preview = try #require(drag.preview)
            #expect(preview.plan.closing != nil && drag.slot != nil)
            try await Task.sleep(nanoseconds: 300_000_000)
            let held = TextFirstBlockReflowTests.image(preview.curtain.layer, h)
            let foot = rect.maxY - h.tv.bounds.minY
            h.controller.endBlockDrag(dropping: true)
            #expect(await h.until(1) { preview.curtain.superview == nil })
            // The tall photo's foot, above where the icon was: as the note draws it now.
            let real = TextFirstBlockReflowTests.screen(h)
            let rows = 0..<(foot - 30)
            let differing = TextFirstBlockReflowTests.differing(held, real, rows: rows)
            #expect(
                differing == 0,
                "\(differing) pixels differ \(TextFirstBlockReflowTests.keep(held, real, "bands"))")
        }

        /// A photo `width` x `height` pixels in bands of changing colour down its height.
        private static func bands(_ width: Int, _ height: Int) -> Data {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(
                size: CGSize(width: width, height: height), format: format
            ).image { context in
                for y in stride(from: 0, to: height, by: 25) {
                    UIColor(
                        hue: CGFloat(y) / CGFloat(height), saturation: 1, brightness: 1, alpha: 1
                    )
                    .setFill()
                    context.fill(CGRect(x: 0, y: y, width: width, height: 25))
                }
            }.pngData()!
        }

        // MARK: helpers

        private func begin(_ h: TextFirstHarness, at p: CGPoint) throws -> TextFirstBlockDrag {
            #expect(h.controller.liftShouldBegin(at: p))
            h.controller.beginBlockDrag(at: p)
            return try #require(h.controller.blockDrag)
        }

        private func hold(_ h: TextFirstHarness, at y: CGFloat) {
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: h.tv.bounds.minY + y))
        }
    }
#endif
