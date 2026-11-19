#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The block drag's live preview once the lifted block is far from what shows (#449 review):
    /// what is laid out, which places the gap may open on, how the gap is judged as the note
    /// scrolls, and the copy and the room the block keeps after its own text has scrolled away.
    @Suite @MainActor
    struct TextFirstBlockReflowFarTests {
        private static let lines = (0..<300).map { "line \($0)" }.joined(separator: "\n")

        @Test func aDragFarFromItsBlockLaysOutNothingAtTheNotesStart() async throws {
            let h = TextFirstHarness(Self.lines, focused: false)
            h.tv.contentOffset.y = h.tv.contentSize.height - h.tv.bounds.height
            h.tv.layoutIfNeeded()
            let manager = try #require(h.tv.textLayoutManager)
            manager.invalidateLayout(for: manager.documentRange)
            h.tv.layoutIfNeeded()
            func startLaidOut() -> Bool {
                manager.textLayoutFragment(for: manager.documentRange.location)?.state
                    == .layoutAvailable
            }
            #expect(!startLaidOut(), "only what shows is laid out")
            let drag = try begin(h, at: h.point(line: 290))
            h.controller.followBlockDrag(to: h.point(line: 287))
            // Scrolled up, step by step, until the block is screens below what is laid out.
            for _ in 0..<5 {
                h.tv.contentOffset.y -= h.tv.bounds.height / 2
                h.tv.layoutIfNeeded()
                h.controller.remeasureBlockDrag()
            }
            let laidOut = try #require(h.controller.laidOutRange())
            #expect(NSMaxRange(laidOut) < drag.lift.block.location)
            #expect(drag.preview?.isOpen == true)
            #expect(!startLaidOut(), "the block's place off screen asked for no layout")
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func theScrollJudgesTheGapAgainstTheRunsWhereTheyAreDrawn() async throws {
            let h = TextFirstHarness(Self.lines, focused: false)
            let drag = try begin(h, at: h.point(line: 3))
            h.controller.followBlockDrag(to: h.point(line: 12))
            let preview = try #require(drag.preview)
            try await Task.sleep(nanoseconds: 300_000_000)
            // Down just past the middle of the run below the gap: the gap steps down, that run
            // sliding up. A scroll that changes no gap leaves that slide as it is.
            let below = preview.gap
            let next =
                preview.plan.top(below, gap: below) + preview.plan.height(below, gap: below) / 2
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: next + 1))
            #expect(preview.gap == below + 1)
            let ends = preview.slidesEnd
            try await Task.sleep(nanoseconds: 50_000_000)
            h.tv.contentOffset.y += 1
            h.tv.layoutIfNeeded()
            h.controller.remeasureBlockDrag()
            #expect(preview.gap == below + 1)
            #expect(abs(preview.slidesEnd - ends) < 0.001, "no slide started again")
            try await Task.sleep(nanoseconds: 300_000_000)
            // Up just past the middle of the run above the gap: the gap steps up and that run
            // starts sliding down.
            let g = preview.gap
            let back = try #require(preview.plan.slot(g))
            let middle = preview.plan.top(g - 1, gap: g) + preview.plan.height(g - 1, gap: g) / 2
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: middle - 1))
            #expect(drag.slot != back)
            // At once the note scrolls 8 pt under the still finger. The run has hardly moved,
            // so the finger is below its middle as drawn: the gap goes back, as a finger moving
            // there would take it.
            h.tv.contentOffset.y += 8
            h.tv.layoutIfNeeded()
            h.controller.remeasureBlockDrag()
            #expect(drag.slot == back)
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func everyPlaceTheGapMayOpenOnFarFromTheBlockIsASlot() async throws {
            let h = TextFirstHarness(Self.lines, focused: false)
            let drag = try begin(h, at: h.point(line: 3))
            h.controller.followBlockDrag(to: h.point(line: 6))
            let preview = try #require(drag.preview)
            // A line's top exactly at the screen's top, far below the block's place.
            let manager = try #require(h.tv.textLayoutManager)
            let inset = h.tv.textContainerInset.top
            for line in [100, 101, 150] {
                h.tv.contentOffset.y = CGFloat(line) * 24.3
                h.tv.layoutIfNeeded()
                let top = try #require(
                    manager.textLayoutFragment(for: CGPoint(x: 1, y: h.tv.bounds.minY - inset + 1)))
                h.tv.contentOffset.y = inset + top.layoutFragmentFrame.minY
                h.tv.layoutIfNeeded()
                h.controller.remeasureBlockDrag()
                let plan = preview.plan
                for g in plan.positions {
                    #expect(
                        plan.slot(g) != nil,
                        "line \(line): \(g) of \(plan.positions.prefix(4)), home \(plan.home) \(plan.homeShown) source \(plan.source) visible \(h.tv.bounds)"
                    )
                }
            }
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aPhotoLiftedOutOfItsLineKeepsItClosedAndItsDrawingOnceItScrollsAway()
            async throws
        {
            let h = TextFirstHarness(
                "caption ![](pic.png)\n" + Self.lines,
                files: ["pic.png": TextFirstHarness.png(900, 900)], focused: false)
            #expect(await h.until { h.lineHeights(at: 0).contains { $0 > 100 } })
            let photo = (h.display as NSString).range(of: "![](pic.png)")
            let laidOut = try #require(h.controller.laidOutRange())
            let rect = try #require(h.controller.drawnImage(photo, in: laidOut))
            let drag = try begin(h, at: CGPoint(x: rect.midX, y: rect.midY))
            #expect(drag.lift.book.alonePhoto)
            h.controller.followBlockDrag(to: h.point(line: 4))
            let preview = try #require(drag.preview)
            let closing = try #require(preview.plan.closing)
            let closes = closing.bottom - closing.top - closing.closed
            let room = preview.plan.room
            let copy = try #require(preview.copyDrawing)
            hold(h, at: h.tv.bounds.height - 30)
            #expect(await h.until(5) { h.tv.contentOffset.y > 3 * h.tv.bounds.height })
            hold(h, at: h.tv.bounds.height / 2)
            #expect(preview.plan.closing == nil, "its line has scrolled away")
            // Everything below its place stays pulled up by what its line closed up by, and
            // the note grows only by what the photo's own line takes beyond that.
            #expect(abs(preview.plan.left - closes) < 0.5)
            #expect(abs(preview.plan.grows(preview.gap) - max(0, room - closes)) < 0.5)
            // The copy in the gap is still the photo.
            let now = try #require(preview.copyDrawing)
            #expect(TextFirstBlockReflowTests.differing(now, copy) == 0)
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aTallParagraphCarriedAwayIsStillDrawnFromItsOwnWords() async throws {
            let tall = Array(repeating: "a tall paragraph's own words", count: 160)
                .joined(separator: " ")
            let before = (0..<120).map { "line \($0)" }.joined(separator: "\n")
            let h = TextFirstHarness("\(before)\n\(tall)\nafter\nend", focused: false)
            h.tv.contentOffset.y = h.tv.contentSize.height - h.tv.bounds.height
            h.tv.layoutIfNeeded()
            let drag = try begin(h, at: CGPoint(x: 60, y: h.tv.bounds.midY))
            #expect(drag.lift.block.length > 3000, "the paragraph lifts")
            let preview = try #require(drag.preview)
            // Up, with the gap at the screen's top and the copy above it; then, the paragraph
            // far below, down the screen, where more of the copy shows.
            let from = h.tv.contentOffset.y
            hold(h, at: 30)
            #expect(await h.until(5) { h.tv.contentOffset.y < from - 4 * h.tv.bounds.height })
            hold(h, at: h.tv.bounds.height - 90)
            let copy = try #require(preview.copyDrawing)
            let window = try #require(preview.copyWindow)
            // The same paragraph alone, drawn for the same stretch of it.
            let alone = TextFirstHarness("line\n\(tall)\nafter", focused: false)
            let painter = TextFirstSlicePainter(textView: alone.tv)
            let top = painter.pixel(alone.point(line: 1, fraction: 0).y)
            let own = try #require(
                painter.paint(
                    CGRect(
                        x: 0, y: top + window.offset, width: alone.tv.bounds.width,
                        height: CGFloat(copy.height) / painter.scale), from: 5))
            let differing = TextFirstBlockReflowTests.differing(copy, own)
            #expect(
                differing == 0,
                "\(differing) pixels differ \(TextFirstBlockReflowTests.keep(copy, own, "far-copy"))"
            )
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aBlockTallerThanWhatIsLaidOutTakesItsWholeHeight() async throws {
            // An item with 200 children lifts whole; only the screen and a margin are laid out.
            let children = (1...200).map { "  - child \($0)" }.joined(separator: "\n")
            let h = TextFirstHarness(
                "intro\n- top\n\(children)\nafter\n"
                    + (0..<40).map { "line \($0)" }
                    .joined(separator: "\n"), focused: false)
            let drag = try begin(h, at: h.point(line: 1))
            #expect(drag.lift.block.length > 1500, "the item lifts with its children")
            drag.follow(h.point(line: 0, fraction: 0.3))
            let preview = try #require(drag.preview)
            let room = preview.plan.room
            // Scrolled into its middle: neither edge is laid out, and nothing of it shows.
            h.tv.contentOffset.y += 2400
            h.tv.layoutIfNeeded()
            h.controller.remeasureBlockDrag()
            let visible = h.tv.bounds
            let source = preview.plan.source
            #expect(source.minY <= visible.minY && source.maxY >= visible.maxY, "\(source)")
            #expect(preview.plan.room == room)
            h.controller.endBlockDrag(dropping: false)
            // Its real height, all of it laid out now.
            let manager = try #require(h.tv.textLayoutManager)
            manager.ensureLayout(for: manager.documentRange)
            let height = h.point(line: 202, fraction: 0).y - h.point(line: 1, fraction: 0).y
            #expect(abs(room - height) < 1, "room \(room), the block \(height)")
        }

        @Test func aCarriedPhotoDecodingAtItsPlaceholdersHeightIsDrawnDecodedInTheGap()
            async throws
        {
            let h = TextFirstHarness(
                "first\nsecond\nthird\n![](pic.png)\nfifth",
                files: ["pic.png": TextFirstHarness.png(1050, 144)], focused: false)
            let at = h.lineStarts[3]
            func loaded() -> Bool {
                (h.controller.storage.attribute(.tfImage, at: at, effectiveRange: nil)
                    as? TextFirstImageSpan)?.atom.image != nil
            }
            #expect(!loaded())
            let drag = try begin(h, at: h.point(line: 3))
            #expect(drag.lift.block.location == at, "its line lifts")
            drag.follow(h.point(line: 0, fraction: 0.3))
            let preview = try #require(drag.preview)
            #expect(preview.isOpen && drag.slot != nil)
            #expect(await h.until { loaded() })
            try await Task.sleep(nanoseconds: 200_000_000)
            // The copy is the photo as it draws now, decoded.
            let copy = try #require(preview.copyDrawing)
            let painter = TextFirstSlicePainter(textView: h.tv)
            let source = preview.plan.source
            let top = painter.pixel(source.minY)
            let real = try #require(
                painter.paint(
                    CGRect(
                        x: source.minX, y: top, width: source.width,
                        height: painter.pixel(source.maxY) - top), from: at))
            let differing = TextFirstBlockReflowTests.differing(copy, real)
            #expect(
                differing == 0,
                "\(differing) pixels differ \(TextFirstBlockReflowTests.keep(copy, real, "decoded-copy"))"
            )
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aCancelPastTheNotesFootLeavesItWithinItsScroll() async throws {
            // An icon sharing a row with a tall photo: lifted, its line keeps its height, and
            // in a gap at the note's end it takes a line of its own: the note grows.
            let h = TextFirstHarness(
                (0..<60).map { "line \($0)" }.joined(separator: "\n")
                    + "\nHi ![](tall.png)![](icon.png)\nlast",
                files: [
                    "tall.png": TextFirstHarness.png(300, 1200),
                    "icon.png": TextFirstHarness.png(60, 60),
                ], focused: false)
            func foot() -> CGFloat {
                h.tv.contentSize.height + h.tv.adjustedContentInset.bottom - h.tv.bounds.height
            }
            h.tv.contentOffset.y = foot()
            h.tv.layoutIfNeeded()
            #expect(await h.until { h.lineHeights(at: h.lineStarts[60]).contains { $0 > 150 } })
            h.tv.contentOffset.y = foot()
            h.tv.layoutIfNeeded()
            let icon = (h.display as NSString).range(of: "![](icon.png)")
            let laidOut = try #require(h.controller.laidOutRange())
            let rect = try #require(h.controller.drawnImage(icon, in: laidOut))
            let drag = try begin(h, at: CGPoint(x: rect.midX, y: rect.midY))
            let preview = try #require(drag.preview)
            hold(h, at: h.tv.bounds.height - 10)
            #expect(await h.until(3) { drag.slot?.end == true })
            #expect(preview.plan.grows(preview.gap) > 20)
            #expect(await h.until(3) { h.tv.contentOffset.y > foot() + 20 })
            h.controller.endBlockDrag(dropping: false)
            #expect(await h.until(1) { preview.curtain.superview == nil })
            #expect(h.tv.contentOffset.y <= foot() + 0.5, "back within the note's scroll")
        }

        // MARK: helpers

        private func begin(_ h: TextFirstHarness, at p: CGPoint) throws -> TextFirstBlockDrag {
            #expect(h.controller.liftShouldBegin(at: p))
            h.controller.beginBlockDrag(at: p)
            return try #require(h.controller.blockDrag)
        }

        /// The finger, still, `y` below the top of what shows.
        private func hold(_ h: TextFirstHarness, at y: CGFloat) {
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: h.tv.bounds.minY + y))
        }
    }
#endif
