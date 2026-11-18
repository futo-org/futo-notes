#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A block drag while the note scrolls under it (#443): the edge autoscroll's speed, and
    /// where the drop line can land once content that was off screen at the lift is laid out.
    /// The drags themselves are `TextFirstBlockDragAutoscrollUITests`.
    @Suite @MainActor
    struct TextFirstBlockDragScrollTests {
        @Test func theNoteScrollsFasterTheDeeperTheFingerIsInAnEdgeZone() {
            // A 700 pt visible area from y 100: zones are 100..<164 and 736..<800.
            let shown: ClosedRange<CGFloat> = 100...800
            func speed(_ y: CGFloat) -> CGFloat { TextFirstAutoscroll.velocity(at: y, in: shown) }
            // Outside the zones, and on their inner lips, nothing scrolls.
            #expect(speed(450) == 0)
            #expect(speed(164) == 0)
            #expect(speed(736) == 0)
            // Just inside a lip 200 pt/s, half way 800, at the edge and past it 1400; up is
            // negative.
            #expect(abs(speed(163.99) + 200) < 1)
            #expect(speed(132) == -800)
            #expect(speed(100) == -1400)
            #expect(speed(40) == -1400)
            #expect(abs(speed(736.01) - 200) < 1)
            #expect(speed(768) == 800)
            #expect(speed(800) == 1400)
            #expect(speed(900) == 1400)
            // A visible area shorter than two zones: the nearer edge wins.
            let short: ClosedRange<CGFloat> = 0...100
            #expect(TextFirstAutoscroll.velocity(at: 40, in: short) < 0)
            #expect(TextFirstAutoscroll.velocity(at: 60, in: short) > 0)
        }

        @Test func oneFrameScrollsAtMostFiftyMillisecondsOfTravel() {
            #expect(TextFirstAutoscroll.step(800, elapsed: 1.0 / 60) == 800.0 / 60)
            // A frame that came late (a hitch) moves no further than 0.05 s would.
            #expect(TextFirstAutoscroll.step(-1400, elapsed: 0.5) == -70)
            #expect(TextFirstAutoscroll.step(1400, elapsed: 0) == 0)
        }

        @Test func slotsThatScrollIntoViewBecomeTargetsWhereTheyAreLaidOut() throws {
            // Line 200 is far below the screen when line 0 lifts.
            let h = TextFirstHarness(
                (0..<300).map { "line \($0)" }.joined(separator: "\n"), focused: false)
            let starts = h.lineStarts
            var lift = try #require(h.controller.liftPlan(at: h.point(line: 0)))
            #expect(!lift.targets.slots.contains { $0.slot.offset == starts[200] })
            // Scrolled a screen at a time, as the autoscroll goes, until line 200 shows.
            var there = lift.targets
            while !there.slots.contains(where: { $0.slot.offset > starts[201] }) {
                h.tv.contentOffset.y += 600
                h.tv.layoutIfNeeded()
                there = try h.controller.dropTargets(&lift.book)
                try #require(h.tv.contentOffset.y < h.tv.contentSize.height)
            }
            #expect(there.slot(nearest: h.point(line: 200, fraction: 0.2).y)?.slot == slot(200))
            #expect(there.slot(nearest: h.point(line: 200, fraction: 0.8).y)?.slot == slot(201))
            // Scrolled back, the block's own edges and the slots asked for at the lift hold.
            h.tv.contentOffset.y = 0
            h.tv.layoutIfNeeded()
            let back = try h.controller.dropTargets(&lift.book)
            #expect(back.slot(nearest: h.point(line: 0).y) == nil)
            #expect(back.slot(nearest: h.point(line: 2, fraction: 0.2).y)?.slot == slot(2))
            func slot(_ line: Int) -> TextFirstBlockSlot {
                TextFirstBlockSlot(offset: starts[line], end: false)
            }
        }

        @Test func aPhotoDecodingMidDragMovesTheDropLineWithTheText() async throws {
            let h = TextFirstHarness(
                "first\n![](pic.png)\nthird\nfourth",
                files: ["pic.png": TextFirstHarness.png(900, 900)], focused: false)
            // `first` lifts before the photo has its height; the finger is above `third`.
            #expect(h.lineHeights(at: h.lineStarts[1]).allSatisfy { $0 < 100 })
            let drag = try begin(h, at: h.point(line: 0))
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: h.point(line: 2, fraction: 0).y))
            #expect(drag.slot?.offset == h.lineStarts[2])
            #expect(await h.until { h.lineHeights(at: h.lineStarts[1]).contains { $0 > 100 } })
            // The photo pushed `third` far down: the still finger is now just under the lifted
            // line's own bottom edge, where a release moves nothing. The drag carries on.
            #expect(h.controller.blockDrag === drag)
            #expect(drag.slot == nil && drag.dropLine.isHidden)
            // Carried to `third` where it is drawn now, the drop line is there.
            let third = h.point(line: 2, fraction: 0).y
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: third))
            #expect(drag.slot?.offset == h.lineStarts[2])
            #expect(drag.dropLine.center.y == third)
        }

        @Test func aRotationMidDragMeasuresTheTargetsAgain() throws {
            let words = Array(repeating: "wrapping words", count: 24).joined(separator: " ")
            let h = TextFirstHarness("A \(words)\nB \(words)\nC \(words)\nD", focused: false)
            let drag = try begin(h, at: h.point(line: 0))
            let portrait = h.point(line: 2, fraction: 0).y
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: portrait))
            #expect(drag.slot?.offset == h.lineStarts[2])
            // Landscape: the paragraphs wrap to fewer rows and `C` moves up.
            h.window.frame.size = CGSize(width: 800, height: 390)
            h.tv.frame = h.window.bounds
            h.tv.layoutIfNeeded()
            let landscape = h.point(line: 2, fraction: 0).y
            #expect(landscape < portrait - 20)
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: landscape))
            #expect(h.controller.blockDrag === drag)
            #expect(drag.slot?.offset == h.lineStarts[2])
            #expect(drag.dropLine.center.y == landscape)
            #expect(drag.dimmedSource.frame.width == 800)
        }

        @Test func aDragEndsWithNothingMovedWhenItsNoteCloses() throws {
            // Closed (leaving the note, or discarding it), or taken off screen (another note
            // pushed over it) while the finger is still down.
            let leaves: [(TextFirstHarness) -> Void] = [
                { $0.controller.discard() }, { $0.tv.removeFromSuperview() },
            ]
            for leave in leaves {
                let h = TextFirstHarness("one\ntwo\nthree", focused: false)
                let drag = try begin(h, at: h.point(line: 0))
                h.controller.followBlockDrag(to: h.point(line: 2, fraction: 0.8))
                #expect(drag.slot != nil)
                leave(h)
                #expect(h.controller.blockDrag == nil)
                let drawn = [drag.card, drag.dropLine, drag.dimmedSource]
                #expect(drawn.allSatisfy { $0.superview == nil })
                // The finger lifts later, over the drop line it saw.
                h.controller.endBlockDrag(dropping: true)
                #expect(h.source == "one\ntwo\nthree")
            }
        }

        @Test func aPhotoDroppedBelowItsOwnLineLeavesTheScreenWhereItWas() async throws {
            // `x` and a photo share line 1; the photo is drawn on a row of its own under `x`.
            // The paragraph above wraps to several rows.
            let rest = (0..<40).map { "line \($0)" }.joined(separator: "\n")
            let above = Array(repeating: "preceding", count: 10).joined(separator: " ")
            let h = TextFirstHarness(
                "\(above)\nx![](pic.png)\n\(rest)",
                files: ["pic.png": TextFirstHarness.png(900, 900)], focused: false)
            #expect(await h.until { h.lineHeights(at: h.lineStarts[1]).contains { $0 > 100 } })
            // Scrolled so the photo's top is cut off, it lifts alone and is carried just below
            // its own line, above `line 0`.
            let onPhoto = h.point(line: 1, x: 70, fraction: 0.6)
            let photo = try #require(h.controller.imageAt(onPhoto)?.frame)
            h.tv.contentOffset.y = photo.minY + 40
            h.tv.layoutIfNeeded()
            let drag = try begin(h, at: onPhoto)
            #expect(drag.lift.block.length == 12)
            let below = h.point(line: 2, fraction: 0).y + 2
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: below))
            #expect(drag.slot?.offset == h.lineStarts[2])
            let before = photo.minY - h.tv.contentOffset.y
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source.hasPrefix("\(above)\nx\n![](pic.png)\nline 0"))
            try await Task.sleep(nanoseconds: 100_000_000)
            // It only went from a row of `x`'s line to a line of its own, which sets it lower by
            // a paragraph's spacing (24 pt): nothing jumps by the paragraph above it.
            let moved = try #require(h.controller.imageAt(h.point(line: 2, x: 70))?.frame)
            let after = moved.minY - h.tv.contentOffset.y
            #expect(abs(after - before) < 30, "\(before) → \(after)")
        }

        @Test func aStillFingerInAnEdgeZoneScrollsTheNote() async throws {
            let h = TextFirstHarness(
                (0..<300).map { "line \($0)" }.joined(separator: "\n"), focused: false)
            // Lifted 30 pt above the bottom edge and never moved.
            _ = try begin(h, at: CGPoint(x: 60, y: h.tv.bounds.maxY - 30))
            #expect(await h.until(2) { h.tv.contentOffset.y > 100 })
            h.controller.endBlockDrag(dropping: false)
            // Lifted mid-screen, then the visible area shrinks under the still finger (a
            // rotation, a bar coming in) until it is 30 pt from the bottom edge.
            let from = h.tv.contentOffset.y
            let middle = CGPoint(x: 60, y: h.tv.bounds.midY)
            _ = try begin(h, at: middle)
            try await Task.sleep(nanoseconds: 200_000_000)
            #expect(h.tv.contentOffset.y == from)
            h.window.frame.size.height = middle.y - h.tv.bounds.minY + 30
            h.tv.frame = h.window.bounds
            h.tv.layoutIfNeeded()
            #expect(await h.until(2) { h.tv.contentOffset.y > from + 100 })
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func aSyncWriteEndsTheDragBeforeTheEditorHasTakenItIn() async throws {
            let h = TextFirstHarness("one\ntwo\nthree", focused: false)
            let drag = try begin(h, at: h.point(line: 0))
            h.controller.followBlockDrag(to: h.point(line: 2, fraction: 0.8))
            #expect(drag.slot != nil)
            // A sync writes the note on disk and the screen hears of it, while the editor's
            // I/O queue is still busy (an earlier save): its checkpoint has not run yet.
            try "one\ntwo\nthree\nfour".write(
                to: h.root.appendingPathComponent("note.md"), atomically: true, encoding: .utf8)
            h.controller.io.async { Thread.sleep(forTimeInterval: 0.3) }
            h.controller.noteChangedOutside()
            #expect(h.controller.blockDrag == nil)
            #expect(drag.card.superview == nil)
            // The finger lifts over the drop line it saw, and holds again: nothing moves, and
            // nothing lifts until the outside text is in.
            h.controller.endBlockDrag(dropping: true)
            #expect(h.controller.liftPlan(at: h.point(line: 0)) == nil)
            #expect(await h.until { h.display == "one\ntwo\nthree\nfour" })
            #expect(h.source == "one\ntwo\nthree\nfour")
            #expect(h.controller.liftPlan(at: h.point(line: 0)) != nil)
        }

        /// Lift what a hold at `p` lifts, as the long-press does at its 340 ms.
        private func begin(_ h: TextFirstHarness, at p: CGPoint) throws -> TextFirstBlockDrag {
            #expect(h.controller.liftShouldBegin(at: p))
            h.controller.beginBlockDrag(at: p)
            return try #require(h.controller.blockDrag)
        }
    }
#endif
