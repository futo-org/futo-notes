#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The block drag's live preview while the note autoscrolls under it (#449): content that
    /// scrolls in is drawn at its previewed place with what it draws now, the gap follows the
    /// content under a still finger, and the drop lands where the preview showed it.
    @Suite @MainActor
    struct TextFirstBlockReflowScrollTests {
        @Test func carriedDownMoreThanTwoScreensThePreviewHoldsAndTheDropLandsInIt() async throws {
            let lines = (0..<300).map { "line \($0)" }
            let h = TextFirstHarness(lines.joined(separator: "\n"), focused: false)
            let drag = try begin(h, at: h.point(line: 3))
            h.controller.followBlockDrag(to: h.point(line: 8))
            let preview = try #require(drag.preview)
            // Held 30 pt above the bottom edge: the note scrolls under the still finger.
            hold(h, at: h.tv.bounds.height - 30)
            #expect(await h.until(5) { h.tv.contentOffset.y > 2 * h.tv.bounds.height })
            // Back mid-screen and still: the scroll stops, the preview is still the drag's.
            hold(h, at: h.tv.bounds.height / 2)
            try await Task.sleep(nanoseconds: 300_000_000)
            #expect(drag.preview === preview && preview.isOpen)
            #expect(preview.curtain.frame == h.tv.bounds)
            try expectSlicesDrawTheirText(h, preview)
            let slot = try #require(drag.slot)
            let landing = try #require(h.lineStarts.firstIndex(of: slot.offset))
            #expect(landing > 30, "the gap followed the content under the finger")
            try await dropAndCompare(h, drag, line: 3, before: landing, of: lines)
        }

        @Test func carriedUpToTheNotesTopThePreviewHoldsAndTheDropLandsInIt() async throws {
            let lines = (0..<200).map { "line \($0)" }
            let h = TextFirstHarness(lines.joined(separator: "\n"), focused: false)
            h.tv.contentOffset.y = h.tv.contentSize.height - h.tv.bounds.height
            h.tv.layoutIfNeeded()
            // Pressed at its middle: the finger is where the block's middle is carried.
            let start = h.point(line: 190)
            let drag = try begin(h, at: start)
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: start.y - 100))
            let preview = try #require(drag.preview)
            hold(h, at: 30)
            #expect(await h.until(8) { h.tv.contentOffset.y <= -h.tv.adjustedContentInset.top })
            // Once the last scroll steps' slides end, the block's middle past line 0's middle as
            // drawn below the gap, short of line 1's.
            try await Task.sleep(nanoseconds: 200_000_000)
            hold(h, at: 4 + 24.3 * 2)
            #expect(drag.preview === preview && preview.isOpen)
            try expectSlicesDrawTheirText(h, preview)
            #expect(drag.slot?.offset == h.lineStarts[1])
            try await dropAndCompare(h, drag, line: 190, before: 1, of: lines)
        }

        @Test func releasedMidSlideWhileTheNoteScrollsItLandsWhereTheGapShowed() async throws {
            let lines = (0..<300).map { "line \($0)" }
            let h = TextFirstHarness(lines.joined(separator: "\n"), focused: false)
            let drag = try begin(h, at: h.point(line: 3))
            h.controller.followBlockDrag(to: h.point(line: 8))
            hold(h, at: h.tv.bounds.height - 30)
            #expect(await h.until(5) { h.tv.contentOffset.y > 1.5 * h.tv.bounds.height })
            // Still scrolling, the gap moving on with runs sliding: let go now.
            let slot = try #require(drag.slot)
            let landing = try #require(h.lineStarts.firstIndex(of: slot.offset))
            try await dropAndCompare(h, drag, line: 3, before: landing, of: lines)
        }

        @Test func carriedThousandsOfLinesTheScreenStillHoldsAtTheDrop() async throws {
            // So long a move leaves TextKit nothing laid out where the screen is.
            let lines = (0..<1500).map { "line \($0)" }
            let h = TextFirstHarness(lines.joined(separator: "\n"), focused: false)
            let drag = try begin(h, at: h.point(line: 2))
            h.controller.followBlockDrag(to: h.point(line: 6))
            while h.tv.contentOffset.y < h.tv.contentSize.height - 3 * h.tv.bounds.height {
                h.tv.contentOffset.y += h.tv.bounds.height / 2
                h.tv.layoutIfNeeded()
                h.controller.remeasureBlockDrag()
            }
            hold(h, at: h.tv.bounds.height / 2)
            try await Task.sleep(nanoseconds: 300_000_000)
            let slot = try #require(drag.slot)
            let landing = try #require(h.lineStarts.firstIndex(of: slot.offset))
            #expect(landing > 1000)
            try await dropAndCompare(h, drag, line: 2, before: landing, of: lines)
        }

        @Test func aTallParagraphCarriedThroughIsDrawnWhereverItShows() async throws {
            let tall = Array(repeating: "words of a tall paragraph", count: 220)
                .joined(separator: " ")
            let lines = ["one", "two", "three", tall] + (0..<60).map { "line \($0)" }
            let h = TextFirstHarness(lines.joined(separator: "\n"), focused: false)
            let drag = try begin(h, at: h.point(line: 0))
            h.controller.followBlockDrag(to: h.point(line: 2))
            let preview = try #require(drag.preview)
            let top = h.point(line: 3, fraction: 0).y
            hold(h, at: h.tv.bounds.height - 30)
            // Deep inside the paragraph, well past what was drawn of it as it came into view.
            #expect(await h.until(6) { h.tv.contentOffset.y > top + 2.5 * h.tv.bounds.height })
            hold(h, at: h.tv.bounds.height / 2)
            try await Task.sleep(nanoseconds: 300_000_000)
            #expect(drag.preview === preview && preview.isOpen)
            try expectSlicesDrawTheirText(h, preview, atLeast: 1)
            h.controller.endBlockDrag(dropping: false)
        }

        @Test func carriedToTheFootOfTheNoteAndLeftShorterItSettlesWithinItsScroll() async throws {
            // A nested item wrapping to more rows than it does at the margin, where it goes when
            // dropped outside any list: the note comes out shorter.
            let long = Array(repeating: "a nested item", count: 9).joined(separator: " ")
            let lines = ["- top", "  - \(long)"] + (0..<150).map { "line \($0)" }
            let h = TextFirstHarness(lines.joined(separator: "\n"), focused: false)
            let rows = h.visualLines(at: h.lineStarts[1]).count
            let drag = try begin(h, at: h.point(line: 1))
            h.controller.followBlockDrag(to: h.point(line: 6))
            hold(h, at: h.tv.bounds.height - 30)
            let foot = {
                h.tv.contentSize.height + h.tv.adjustedContentInset.bottom - h.tv.bounds.height
            }
            #expect(await h.until(8) { h.tv.contentOffset.y >= foot() - 0.5 })
            // Held there, the gap at the note's end.
            #expect(drag.preview?.isOpen == true)
            #expect(drag.slot?.end == true)
            let height = h.tv.contentSize.height
            try await dropAndCompare(
                h, drag, line: 1, before: lines.count, of: lines, arriving: "- \(long)",
                holds: false)
            #expect(h.tv.contentSize.height < height, "the note is shorter")
            let landed = h.visualLines(at: h.lineStarts[lines.count - 1]).count
            #expect(landed < rows, "\(rows) rows, then \(landed)")
            // Where the screen cannot hold still it slides to the foot within the landing.
            #expect(abs(h.tv.contentOffset.y - foot()) < 0.5, "at the new foot")
            #expect((h.controller.lastLanding ?? 1) <= 0.41)
        }

        @Test func aPhotoLoadingAfterItScrolledInIsDrawnWhereAndAsItIsNow() async throws {
            var lines = (0..<120).map { "line \($0)" }
            lines[70] = "![](pic.png)"
            let h = TextFirstHarness(
                lines.joined(separator: "\n"), files: ["pic.png": TextFirstHarness.png(900, 900)],
                focused: false)
            let drag = try begin(h, at: h.point(line: 2))
            h.controller.followBlockDrag(to: h.point(line: 6))
            let preview = try #require(drag.preview)
            hold(h, at: h.tv.bounds.height - 30)
            let photo = h.lineStarts[70]
            #expect(
                await h.until(8) {
                    (h.controller.storage.attribute(.tfImage, at: photo, effectiveRange: nil)
                        as? TextFirstImageSpan)?.atom.image != nil
                        && h.tv.contentOffset.y > h.point(line: 72).y - h.tv.bounds.height
                })
            hold(h, at: h.tv.bounds.height / 2)
            try await Task.sleep(nanoseconds: 400_000_000)
            #expect(drag.preview === preview && preview.isOpen)
            try expectSlicesDrawTheirText(h, preview)
            h.controller.endBlockDrag(dropping: false)
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

        /// Every slice the curtain shows holds what its text draws now: the curtain, where the
        /// plan draws each run, against the note drawn as it is laid out now at the run's place,
        /// for the part of each run that shows.
        private func expectSlicesDrawTheirText(
            _ h: TextFirstHarness, _ preview: TextFirstReflow, atLeast: Int = 10
        ) throws {
            let curtain = TextFirstBlockReflowTests.image(preview.curtain.layer, h)
            let painter = TextFirstSlicePainter(textView: h.tv)
            let scale = painter.scale
            let visible = h.tv.bounds
            var checked = 0
            for (j, run) in preview.plan.runs.enumerated()
            where preview.plan.height(j, gap: preview.gap) == run.height {
                // In pixel rows of the curtain: where the run is drawn and what of it shows.
                let drawn =
                    ((painter.pixel(preview.plan.top(j, gap: preview.gap)) - visible.minY)
                    * scale).rounded()
                let rows = ((painter.pixel(run.top + run.height) - painter.pixel(run.top)) * scale)
                    .rounded()
                let from = max(drawn, 0)
                let to = min(drawn + rows, CGFloat(curtain.height))
                guard to - from > 12 else { continue }
                let band = CGRect(
                    x: 0, y: painter.pixel(run.top) + (from - drawn) / scale, width: visible.width,
                    height: (to - from) / scale)
                let real = try #require(painter.paint(band))
                let shown = try #require(
                    curtain.cropping(
                        to: CGRect(x: 0, y: from, width: CGFloat(real.width), height: to - from)))
                let differing = TextFirstBlockReflowTests.differing(shown, real)
                #expect(differing == 0, "run \(j) at \(drawn): \(differing) pixels differ")
                checked += 1
            }
            #expect(checked >= atLeast, "\(checked) runs on screen")
        }

        /// Release `drag` of display line `line` (of `lines`) over the gap above line `before`:
        /// the note moves so (the line `arriving` as it does) and the preview's settled picture
        /// is the note. When the screen `holds` still: nothing on screen but the copy moves at
        /// the release, neither the settled picture nor where each slide starts from, and the
        /// moved line is where the copy was drawn.
        private func dropAndCompare(
            _ h: TextFirstHarness, _ drag: TextFirstBlockDrag, line: Int, before: Int,
            of lines: [String], arriving: String? = nil, holds: Bool = true
        ) async throws {
            let preview = try #require(drag.preview)
            let copy = preview.copyFrame.offsetBy(dx: 0, dy: -h.tv.bounds.minY)
            let held = TextFirstBlockReflowTests.image(preview.curtain.layer, h)
            let drawn = preview.drawnOnScreen
            var moved = lines
            let block = moved.remove(at: line)
            moved.insert(arriving ?? block, at: before > line ? before - 1 : before)
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source == moved.joined(separator: "\n"))
            let starts = preview.slideStarts
            for (j, (was, from)) in zip(drawn, starts).enumerated() where holds {
                guard let was, let from else { continue }
                #expect(abs(was - from) < 0.5, "run \(j) drawn at \(was), slides from \(from)")
            }
            let settled = TextFirstBlockReflowTests.image(preview.curtain.layer, h)
            let scale = CGFloat(held.width) / h.tv.bounds.width
            for (i, rows) in [
                CGRect(
                    x: 0, y: 0, width: CGFloat(held.width), height: (copy.minY * scale).rounded()),
                CGRect(
                    x: 0, y: (copy.maxY * scale).rounded(), width: CGFloat(held.width),
                    height: CGFloat(held.height) - (copy.maxY * scale).rounded()),
            ].enumerated() where rows.height > 0 && holds {
                let a = try #require(held.cropping(to: rows))
                let b = try #require(settled.cropping(to: rows))
                let differing = TextFirstBlockReflowTests.differing(a, b)
                #expect(
                    differing == 0,
                    "\(differing) pixels moved at the drop \(TextFirstBlockReflowTests.keep(a, b, "held\(i)"))"
                )
            }
            #expect(await h.until(1) { preview.curtain.superview == nil })
            let real = TextFirstBlockReflowTests.screen(h)
            let differing = TextFirstBlockReflowTests.differing(settled, real)
            #expect(
                differing == 0,
                "\(differing) pixels differ \(TextFirstBlockReflowTests.keep(settled, real, "scroll"))"
            )
            guard holds else { return }
            let at = h.point(line: before > line ? before - 1 : before, fraction: 0).y
            #expect(abs(at - h.tv.bounds.minY - copy.minY) < 0.5, "landed \(at) vs copy \(copy)")
        }
    }
#endif
