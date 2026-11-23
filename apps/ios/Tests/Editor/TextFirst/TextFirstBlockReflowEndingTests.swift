#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The block drag's live preview at the ends of lines and of the note (#449, !719 review):
    /// CRLF lines, laid out apart and landed, and a block before, carrying or being the note's
    /// empty last task.
    @Suite @MainActor
    struct TextFirstBlockReflowEndingTests {
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
            #expect(NSMaxRange(block) == h.controller.storage.length - 1, "it ends above the task")
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

        @Test func aBlockAtTheNotesEndTakesTheEmptyTaskOnlyWhenItCarriesIt() throws {
            // (note, line lifted, whether the block runs to the note's end)
            for (note, line, toEnd) in [
                ("first\ncaption\n- [ ] ", 1, false),  // a caption above a separate task
                ("first\n- parent\n  - [ ] ", 1, true),  // a parent and its empty child
                ("first\n- [ ] milk\n- [ ] ", -1, true),  // the empty task itself
            ] {
                let h = TextFirstHarness(note, focused: false)
                let length = h.controller.storage.length
                // The empty task is its marker unit alone, on a row of its own.
                let point = h.point(line: line < 0 ? 2 : line, fraction: 0.15)
                let lift = try #require(h.controller.liftPlan(at: point), "\(note)")
                #expect(lift.book.block.toEnd == toEnd, "\(note)")
                #expect(
                    (lift.block == NSRange(location: length - 1, length: 1)) == (line < 0),
                    "\(note): \(lift.block)")
                let block = lift.block
                let layout = try #require(
                    TextFirstBlockLayout(
                        h.controller.storage, block: block, width: h.tv.textContainer.size.width,
                        drawing: 0, host: h.controller, toEnd: lift.book.block.toEnd), "\(note)")
                // As tall as between its edges in the note.
                let laidOut = try #require(h.controller.laidOutRange())
                let top = try #require(
                    h.controller.boundaryY(
                        TextFirstBlockSlot(offset: block.location, end: false), in: laidOut))
                let foot = try #require(
                    h.controller.boundaryY(
                        toEnd
                            ? TextFirstBlockSlot(offset: length, end: true)
                            : TextFirstBlockSlot(offset: NSMaxRange(block), end: false),
                        in: laidOut))
                #expect(abs(layout.height - (foot - top)) < 0.5, "\(note): \(layout.height)")
                // The task's box drawn with the block, as its last row, when it carries the
                // task. (A task the block does not carry is an ordinary line below its foot.)
                guard toEnd else { continue }
                let painter = TextFirstSlicePainter(textView: h.tv)
                let row = (layout.height - 24)...layout.height
                let image = try #require(
                    layout.paint(
                        CGRect(
                            x: 0, y: row.lowerBound, width: h.tv.bounds.width,
                            height: row.upperBound - row.lowerBound),
                        blockTop: 0, with: painter), "\(note)")
                #expect(Self.marked(image, below: 0, h), "\(note): the task's box")
            }
        }

        @Test func aParentWithAnEmptyLastChildLandsWithIt() async throws {
            let h = TextFirstHarness("one\ntwo\n- parent\n  - [ ] ", focused: false)
            let drag = try begin(h, at: h.point(line: 2, fraction: 0.15))
            #expect(drag.lift.book.block.toEnd)
            let preview = try #require(drag.preview)
            // Its place and its copy are both rows: the parent's and its empty child's.
            #expect(preview.plan.room > 40, "\(preview.plan.room)")
            drag.follow(h.point(line: 0, fraction: 0.3))
            #expect(drag.slot?.offset == 0)
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source == "- parent\n  - [ ] \none\ntwo")
            let settled = TextFirstBlockReflowTests.image(preview.curtain.layer, h)
            #expect(await h.until(1) { preview.curtain.superview == nil })
            let real = TextFirstBlockReflowTests.screen(h)
            let differing = TextFirstBlockReflowTests.differing(settled, real)
            #expect(
                differing == 0,
                "\(differing) pixels differ \(TextFirstBlockReflowTests.keep(settled, real, "child"))"
            )
        }

        /// Whether `image` holds anything but the surface colour below pixel row `row`.
        private static func marked(_ image: CGImage, below row: CGFloat, _ h: TextFirstHarness)
            -> Bool
        {
            let from = Int(max(0, row))
            guard from < image.height,
                let tail = image.cropping(
                    to: CGRect(x: 0, y: from, width: image.width, height: image.height - from))
            else { return false }
            let format = UIGraphicsImageRendererFormat()
            (format.scale, format.opaque) = (1, true)
            let blank = UIGraphicsImageRenderer(
                size: CGSize(width: tail.width, height: tail.height), format: format
            ).image { context in
                TextFirstSlicePainter(textView: h.tv).surface.setFill()
                context.fill(CGRect(x: 0, y: 0, width: tail.width, height: tail.height))
            }.cgImage!
            return TextFirstBlockReflowTests.differing(tail, blank) > 20
        }

        // MARK: helpers

        private func begin(_ h: TextFirstHarness, at p: CGPoint) throws -> TextFirstBlockDrag {
            #expect(h.controller.liftShouldBegin(at: p))
            h.controller.beginBlockDrag(at: p)
            return try #require(h.controller.blockDrag)
        }
    }
#endif
