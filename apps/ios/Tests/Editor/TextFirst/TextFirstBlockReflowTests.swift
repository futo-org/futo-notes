#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The block drag's live preview (#448) on a real laid-out note: which gap a finger opens,
    /// what the preview draws against what the screen showed and what the drop leaves, and the
    /// landing. Drags with real touches are `TextFirstBlockReflowUITests`.
    @Suite @MainActor
    struct TextFirstBlockReflowTests {
        @Test func theGapPassesABlockAtItsMiddleAsDrawnAndDoesNotFlicker() async throws {
            // `alpha` lifts; below it a heading, a paragraph of several rows, and `delta`.
            let words = Array(repeating: "wrapping words", count: 12).joined(separator: " ")
            let h = TextFirstHarness("alpha\n# Heading\n\(words)\ndelta", focused: false)
            let starts = h.lineStarts
            func y(_ line: Int, _ fraction: CGFloat) -> CGFloat {
                h.point(line: line, fraction: fraction).y
            }
            let height = y(1, 0) - y(0, 0)
            let drag = try begin(h, at: h.point(line: 0))
            let preview = try #require(drag.preview)
            func follow(_ at: CGFloat) -> Bool { drag.follow(CGPoint(x: 60, y: at)) }
            func gap() -> Int? { drag.slot?.offset }
            // The finger rests until what slid has arrived (mid-slide, the gap is judged against
            // blocks where they are on their way: TextFirstBlockReflowEdgeTests).
            func rest() async throws { try await Task.sleep(nanoseconds: 250_000_000) }
            // Short of the heading's middle nothing moves and the note is not covered.
            #expect(!follow(y(1, 0.5) - 1) && gap() == nil && !preview.isOpen)
            // Past it the gap opens below the heading, with a tick.
            #expect(follow(y(1, 0.5) + 1) && gap() == starts[2] && preview.isOpen)
            try await rest()
            // The heading is now drawn the block's height higher: a finger resting by its old
            // middle, or anywhere short of its middle as drawn now, changes nothing.
            for at in [y(1, 0.5) - 2, y(1, 0.5) + 2, y(1, 0.5) - height + 1] {
                #expect(!follow(at) && gap() == starts[2], "\(at)")
            }
            // Above that middle the gap is home again: no tick, nothing would move.
            #expect(!follow(y(1, 0.5) - height - 1) && gap() == nil)
            try await rest()
            // A quick move down passes the heading and the tall paragraph at once.
            #expect(follow(y(2, 0.5) + 1) && gap() == starts[3])
            try await rest()
            for at in [y(2, 0.5) - 3, y(2, 0.5) - height + 1] {
                #expect(!follow(at) && gap() == starts[3], "\(at)")
            }
            // Past `delta`'s middle it opens after the note's last line.
            #expect(
                follow(y(3, 0.5) + 1)
                    && drag.slot == TextFirstBlockSlot(offset: starts[3] + 5, end: true))
            h.controller.endBlockDrag(dropping: false)
        }

        @Test(arguments: ["light", "dark"])
        func theCurtainAppearsShowingWhatTheTextViewDrew(theme: String) async throws {
            let h = TextFirstHarness(
                Self.mixed, files: ["pic.png": TextFirstHarness.png(900, 360)], focused: false)
            h.controller.setTheme(theme)
            let photo = (h.display as NSString).range(of: "![](pic.png)").location
            #expect(await h.until { h.lineHeights(at: photo).contains { $0 > 100 } })
            let drag = try begin(h, at: h.point(line: 2))
            let preview = try #require(drag.preview)
            // The text view as it draws itself, the block dimmed (the card is over it all).
            drag.card.isHidden = true
            let drawn = Self.image(h.tv.layer, h, over: preview.painter.surface)
            // The gap opens and closes again: the curtain is up, everything in its place.
            drag.follow(h.point(line: 6))
            #expect(preview.isOpen && drag.slot != nil)
            drag.follow(h.point(line: 2, fraction: 0.1))
            #expect(preview.isOpen && drag.slot == nil)
            let curtain = Self.image(preview.curtain.layer, h)
            let differing = Self.differing(drawn, curtain)
            #expect(
                differing == 0,
                "\(differing) pixels differ \(Self.keep(drawn, curtain, "open-\(theme)"))")
            h.controller.endBlockDrag(dropping: false)
        }

        /// A heading, a paragraph, `lifted` (display line 2), a nested list, a task, code, a
        /// quote, a link, a photo and a table.
        static let mixed = """
            # Title
            Some **bold** text and `code` in a line.
            lifted
            - one
              - nested
            - [x] done
            ```swift
            let x = 1
            ```
            > quoted
            [link](https://example.com)
            ![](pic.png)
            | a | b |
            |---|---|
            | 1 | 2 |
            """

        @Test func aDropMovesTheNoteAtOnceUnderThePreviewAndUncoversTheSamePicture() async throws {
            // (note, line lifted, line whose top the finger is carried just past the middle
            // of, note after the drop)
            let words = Array(repeating: "wrapping words", count: 10).joined(separator: " ")
            let cases: [(String, Int, Int, String)] = [
                // Down past two lines to just above a heading.
                ("one\ntwo\nthree\n## Head\nfour", 0, 2, "two\nthree\none\n## Head\nfour"),
                // An item down its list.
                ("intro\n- a\n- b\n- c\nend", 1, 3, "intro\n- b\n- c\n- a\nend"),
                // Up to the note's first line.
                ("one\n\(words)\nthree", 2, 0, "three\none\n\(words)"),
                // Down to after the note's last line.
                ("one\ntwo\n\(words)", 0, 2, "two\n\(words)\none"),
            ]
            for (index, (note, line, past, after)) in cases.enumerated() {
                let h = TextFirstHarness(note, focused: false)
                let up = past < line
                let drag = try begin(h, at: h.point(line: line))
                drag.follow(h.point(line: past, fraction: up ? 0.4 : 0.6))
                let preview = try #require(drag.preview)
                #expect(preview.isOpen && drag.slot != nil, "\(note)")
                let copy = preview.copyFrame
                let scrolled = h.tv.contentOffset
                let released = Date()
                h.controller.endBlockDrag(dropping: true)
                // At once: the card goes, and the note is moved under the preview.
                #expect(drag.card.superview == nil)
                #expect(h.source == after, "\(note)")
                // The preview's last picture, everything settled where the moved note is drawn.
                let settled = Self.image(preview.curtain.layer, h)
                #expect(
                    h.controller.liftPlan(at: h.point(line: 0)) == nil, "no lift while it lands")
                #expect(await h.until(1) { preview.curtain.superview == nil })
                #expect(Date().timeIntervalSince(released) < 0.5)
                #expect(h.tv.contentOffset == scrolled, "the screen does not scroll")
                let real = Self.screen(h)
                let differing = Self.differing(settled, real)
                #expect(
                    differing == 0,
                    "case \(index): \(differing) pixels differ \(Self.keep(settled, real, "land-\(index)"))"
                )
                // The block is where its copy was drawn.
                let moved = after.components(separatedBy: "\n").firstIndex(
                    of: note.components(separatedBy: "\n")[line])!
                let landed = h.point(line: moved, fraction: 0).y
                #expect(abs(landed - copy.minY) < 5, "\(note): \(landed) vs \(copy.minY)")
                h.controller.undo()
                #expect(h.source == note, "one Undo puts it back")
            }
        }

        @Test func aPhotoLeavesItsLineClosedUpAndLandsAsALineOfItsOwn() async throws {
            // As the maintainer's `Nice!![](…)`: text, then a photo drawn on a row of its own.
            let h = TextFirstHarness(
                "intro\nNice! Nice!![](pic.png)\nnext\nmore",
                files: ["pic.png": TextFirstHarness.png(900, 600)], focused: false)
            #expect(await h.until { h.lineHeights(at: 6).contains { $0 > 100 } })
            let drag = try begin(h, at: h.point(line: 1, x: 70, fraction: 0.7))
            let preview = try #require(drag.preview)
            #expect(drag.lift.book.alonePhoto)
            // Carried past `next`: the photo's line closes up to `Nice! Nice!` and the photo
            // sits in the gap above `more`.
            drag.follow(h.point(line: 2, fraction: 0.6))
            #expect(drag.slot?.offset == h.lineStarts[3])
            let copy = preview.copyFrame
            let shown = Self.image(preview.curtain.layer, h)
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source == "intro\nNice! Nice!\nnext\n![](pic.png)\nmore")
            let settled = Self.image(preview.curtain.layer, h)
            #expect(await h.until(1) { preview.curtain.superview == nil })
            let real = Self.screen(h)
            // The preview drew the photo's line closed up as the move left it: its words, wrapped
            // the same, within a point of where the move leaves them (the landing slides that
            // point; the line laid out off screen draws its glyphs a fraction apart).
            let top = h.point(line: 1, fraction: 0).y - h.tv.bounds.minY
            let line = top..<(h.point(line: 2, fraction: 0).y - h.tv.bounds.minY)
            let (drawn, landed) = (Self.ink(shown, rows: line), Self.ink(real, rows: line))
            #expect(
                zip(drawn, landed).allSatisfy { abs($0 - $1) <= 3 },
                "\(drawn) vs \(landed) \(Self.keep(shown, real, "photo-line"))")
            let differing = Self.differing(settled, real)
            #expect(
                differing == 0, "\(differing) pixels differ \(Self.keep(settled, real, "photo"))")
            #expect(abs(h.point(line: 3, fraction: 0).y - copy.minY) < 5)
        }

        @Test func aPhotoDecodingMidDragMeasuresThePreviewAgain() async throws {
            let h = TextFirstHarness(
                "a\nb\nc\nfirst\n![](pic.png)\nthird\nfourth",
                files: ["pic.png": TextFirstHarness.png(900, 900)], focused: false)
            // `first` lifts before the photo has its height; the gap opens above `fourth`
            // (both clear of the edge zones).
            #expect(h.lineHeights(at: h.lineStarts[4]).allSatisfy { $0 < 100 })
            let drag = try begin(h, at: h.point(line: 3))
            h.controller.followBlockDrag(to: h.point(line: 5, fraction: 0.6))
            #expect(drag.slot?.offset == h.lineStarts[6])
            #expect(await h.until { h.lineHeights(at: h.lineStarts[4]).contains { $0 > 100 } })
            // The photo pushes everything down, the runs sliding there from where they were
            // drawn: the gap is judged against them as drawn, as the finger's own moves are, and
            // stays without a tick. The drag goes on; carried to `third` as drawn now, it opens
            // there.
            #expect(h.controller.blockDrag === drag && drag.slot?.offset == h.lineStarts[6])
            #expect(drag.previewUnavailable == nil, "\(drag.previewUnavailable ?? "")")
            try await Task.sleep(nanoseconds: 250_000_000)
            h.controller.followBlockDrag(to: h.point(line: 5, fraction: 0.6))
            #expect(drag.slot?.offset == h.lineStarts[6])
            try await dropAndCompare(
                h, drag, after: "a\nb\nc\n![](pic.png)\nthird\nfirst\nfourth", "decode")
        }

        @Test func aRotationMidDragMeasuresThePreviewAgain() async throws {
            let words = Array(repeating: "wrapping words", count: 8).joined(separator: " ")
            let h = TextFirstHarness(
                "a\nb\nc\nfirst\n\(words)\nthird\nfourth", focused: false)
            let drag = try begin(h, at: h.point(line: 3))
            h.controller.followBlockDrag(to: h.point(line: 5, fraction: 0.6))
            #expect(drag.slot?.offset == h.lineStarts[6])
            // Turned sideways the paragraph wraps to fewer rows; the gap stays on its slot and
            // the curtain covers the new bounds.
            h.window.frame.size = CGSize(width: 800, height: 390)
            h.tv.frame = h.window.bounds
            h.tv.layoutIfNeeded()
            let preview = try #require(drag.preview)
            #expect(preview.curtain.frame == h.tv.bounds)
            // The gap is judged again where everything is drawn now; once it has arrived,
            // carried to `third` as drawn now, it opens above `fourth`.
            try await Task.sleep(nanoseconds: 250_000_000)
            h.controller.followBlockDrag(to: h.point(line: 5, fraction: 0.3))
            #expect(drag.slot?.offset == h.lineStarts[6])
            try await dropAndCompare(
                h, drag, after: "a\nb\nc\n\(words)\nthird\nfirst\nfourth", "rotation")
        }

        /// Release `drag`: the note is `after`, and the preview's settled picture is the note.
        private func dropAndCompare(
            _ h: TextFirstHarness, _ drag: TextFirstBlockDrag, after: String, _ name: String
        ) async throws {
            let preview = try #require(drag.preview)
            h.controller.endBlockDrag(dropping: true)
            #expect(h.source == after)
            let settled = Self.image(preview.curtain.layer, h)
            #expect(await h.until(1) { preview.curtain.superview == nil })
            let real = Self.screen(h)
            let differing = Self.differing(settled, real)
            #expect(differing == 0, "\(differing) pixels differ \(Self.keep(settled, real, name))")
        }

        @Test func theNoteScrollingUnderAStillFingerMovesTheGapWithoutATick() async throws {
            let h = TextFirstHarness(
                (0..<300).map { "line \($0)" }.joined(separator: "\n"), focused: false)
            let from = h.tv.contentOffset.y
            let drag = try begin(h, at: h.point(line: 3))
            h.controller.followBlockDrag(to: h.point(line: 8))
            let preview = try #require(drag.preview)
            // Into the bottom edge zone and still: the note scrolls under the preview.
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: h.tv.bounds.maxY - 30))
            let ticks = h.controller.dragHaptics.ticks
            let slot = try #require(drag.slot)
            #expect(await h.until(3) { h.tv.contentOffset.y > from + 600 })
            #expect(drag.preview === preview && preview.isOpen && drag.dropLine.isHidden)
            #expect(try #require(drag.slot).offset > slot.offset + 150, "the gap moved on")
            #expect(h.controller.dragHaptics.ticks == ticks, "and never ticked")
            h.controller.endBlockDrag(dropping: false)
        }

        // MARK: helpers

        /// Lift what a hold at `p` lifts, as the long-press does at its 340 ms.
        private func begin(_ h: TextFirstHarness, at p: CGPoint) throws -> TextFirstBlockDrag {
            #expect(h.controller.liftShouldBegin(at: p))
            h.controller.beginBlockDrag(at: p)
            return try #require(h.controller.blockDrag)
        }

    }
#endif
