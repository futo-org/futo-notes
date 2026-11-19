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
        @Test func theGapPassesABlockAtItsMiddleAsDrawnAndDoesNotFlicker() throws {
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
            // Short of the heading's middle nothing moves and the note is not covered.
            #expect(!follow(y(1, 0.5) - 1) && gap() == nil && !preview.isOpen)
            // Past it the gap opens below the heading, with a tick.
            #expect(follow(y(1, 0.5) + 1) && gap() == starts[2] && preview.isOpen)
            // The heading is now drawn the block's height higher: a finger resting by its old
            // middle, or anywhere short of its middle as drawn now, changes nothing.
            for at in [y(1, 0.5) - 2, y(1, 0.5) + 2, y(1, 0.5) - height + 1] {
                #expect(!follow(at) && gap() == starts[2], "\(at)")
            }
            // Above that middle the gap is home again: no tick, nothing would move.
            #expect(!follow(y(1, 0.5) - height - 1) && gap() == nil)
            // A quick move down passes the heading and the tall paragraph at once.
            #expect(follow(y(2, 0.5) + 1) && gap() == starts[3])
            for at in [y(2, 0.5) - 3, y(2, 0.5) - height + 1] {
                #expect(!follow(at) && gap() == starts[3], "\(at)")
            }
            // Past `delta`'s middle it opens after the note's last line.
            #expect(
                follow(y(3, 0.5) + 1)
                    && drag.slot == TextFirstBlockSlot(offset: starts[3] + 5, end: true))
            h.controller.endBlockDrag(dropping: false)
        }

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
            // The photo pushed everything down: the still finger is now over the photo's upper
            // half, beside the block's own place, and the gap is judged home again, without
            // a tick. The drag goes on; carried to `third` as drawn now, it opens there.
            #expect(h.controller.blockDrag === drag && drag.slot == nil)
            #expect(drag.previewUnavailable == nil, "\(drag.previewUnavailable ?? "")")
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

        @Test func anAutoscrollHandsTheDragToTheDropLineOnceWhatSlidIsBack() async throws {
            let h = TextFirstHarness(
                (0..<300).map { "line \($0)" }.joined(separator: "\n"), focused: false)
            let from = h.tv.contentOffset.y
            let drag = try begin(h, at: h.point(line: 3))
            h.controller.followBlockDrag(to: h.point(line: 8))
            let preview = try #require(drag.preview)
            #expect(preview.isOpen && drag.slot != nil)
            // Into the bottom edge zone: nothing scrolls while what slid slides back home.
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: h.tv.bounds.maxY - 30))
            #expect(drag.preview === preview && drag.slot == nil && h.tv.contentOffset.y == from)
            #expect(await h.until(1) { drag.preview == nil })
            #expect(preview.curtain.superview == nil && drag.dimmedSource.superview != nil)
            #expect(await h.until(2) { h.tv.contentOffset.y > from + 100 })
            // From here on it is the drop line's drag.
            h.controller.followBlockDrag(to: CGPoint(x: 60, y: h.tv.bounds.midY))
            #expect(drag.preview == nil && !drag.dropLine.isHidden && drag.slot != nil)
            h.controller.endBlockDrag(dropping: false)
        }

        // MARK: helpers

        /// Lift what a hold at `p` lifts, as the long-press does at its 340 ms.
        private func begin(_ h: TextFirstHarness, at p: CGPoint) throws -> TextFirstBlockDrag {
            #expect(h.controller.liftShouldBegin(at: p))
            h.controller.beginBlockDrag(at: p)
            return try #require(h.controller.blockDrag)
        }

        /// The note on screen as the editor draws it (the test host cannot capture its real
        /// screen; the UI tests compare the preview with real screenshots).
        static func screen(_ h: TextFirstHarness) -> CGImage {
            h.tv.layoutIfNeeded()
            let drawn = TextFirstSlicePainter(textView: h.tv).paint(h.tv.bounds)!
            let layer = CALayer()
            layer.frame = CGRect(origin: .zero, size: h.tv.bounds.size)
            layer.contents = drawn
            layer.contentsGravity = .topLeft
            layer.contentsScale = h.tv.traitCollection.displayScale
            return image(layer, h)
        }

        /// `layer` drawn as its model tree stands (no animation in flight), the text view's
        /// size at the screen's scale.
        static func image(_ layer: CALayer, _ h: TextFirstHarness, over: UIColor? = nil) -> CGImage
        {
            h.tv.layoutIfNeeded()
            let format = UIGraphicsImageRendererFormat(for: h.tv.traitCollection)
            format.opaque = true
            return UIGraphicsImageRenderer(size: h.tv.bounds.size, format: format).image { ui in
                if let over {
                    over.setFill()
                    ui.cgContext.fill(CGRect(origin: .zero, size: h.tv.bounds.size))
                }
                h.tv.traitCollection.performAsCurrent { layer.render(in: ui.cgContext) }
            }.cgImage!
        }

        /// When a comparison fails: both images, kept where the run's log names them.
        static func keep(_ a: CGImage, _ b: CGImage, _ name: String) -> String {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("reflow")
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            for (image, side) in [(a, "a"), (b, "b")] {
                try? UIImage(cgImage: image).pngData()?.write(
                    to: dir.appendingPathComponent("\(name)-\(side).png"))
            }
            return dir.path
        }

        /// The box of an image's ink (dark pixels) in `rows` (points from the top), in pixels:
        /// top, bottom, left, right.
        static func ink(_ image: CGImage, rows: Range<CGFloat>) -> [Int] {
            let p = bytes(image)
            let scale = CGFloat(image.width) / UIScreen.main.bounds.width
            var box = [Int.max, -1, Int.max, -1]
            for r in max(
                0, Int(rows.lowerBound * scale))..<min(image.height, Int(rows.upperBound * scale))
            {
                for c in 0..<image.width where p[(r * image.width + c) * 4] < 100 {
                    box = [min(box[0], r), max(box[1], r), min(box[2], c), max(box[3], c)]
                }
            }
            return box
        }

        /// How many pixels of two same-sized images differ by more than `threshold` in a channel,
        /// in all rows or `rows` (points from the top).
        static func differing(
            _ a: CGImage, _ b: CGImage, rows: Range<CGFloat>? = nil, threshold: Int = 24
        ) -> Int {
            let (pa, pb) = (bytes(a), bytes(b))
            guard pa.count == pb.count else { return Int.max }
            let scale = CGFloat(a.width) / UIScreen.main.bounds.width
            let row = a.width * 4
            let from = rows.map { max(0, Int($0.lowerBound * scale)) * row } ?? 0
            let to = rows.map { min(a.height, Int($0.upperBound * scale)) * row } ?? pa.count
            var count = 0
            for i in stride(from: from, to: max(from, to), by: 4) {
                for c in 0..<3 where abs(Int(pa[i + c]) - Int(pb[i + c])) > threshold {
                    count += 1
                    break
                }
            }
            return count
        }

        private static func bytes(_ image: CGImage) -> [UInt8] {
            var out = [UInt8](repeating: 0, count: image.width * image.height * 4)
            out.withUnsafeMutableBytes { raw in
                let context = CGContext(
                    data: raw.baseAddress, width: image.width, height: image.height,
                    bitsPerComponent: 8, bytesPerRow: image.width * 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                context?.draw(
                    image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            }
            return out
        }
    }
#endif
