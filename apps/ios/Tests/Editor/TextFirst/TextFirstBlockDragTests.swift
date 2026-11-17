#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The long-press block drag's two decisions on a laid-out note: which block a press at a
    /// point lifts (or that it keeps the platform's long-press), and which slot a finger at a
    /// point drops it on. The drag itself is `TextFirstBlockDragUITests`.
    @Suite @MainActor
    struct TextFirstBlockDragTests {
        /// The display's line starts (UTF-16), one per line, the empty last line included.
        private func lineStarts(_ h: TextFirstHarness) -> [Int] {
            let text = (h.tv.text ?? "") as NSString
            var starts = [0]
            for i in 0..<text.length where text.character(at: i) == 0x0A { starts.append(i + 1) }
            return starts
        }

        /// A point in the middle of display line `line`, `x` from the text view's left edge,
        /// `fraction` of the way down the line's paragraph.
        private func point(
            _ h: TextFirstHarness, line: Int, x: CGFloat = 60, fraction: CGFloat = 0.5
        ) -> CGPoint {
            h.tv.layoutIfNeeded()
            let manager = h.tv.textLayoutManager!
            let location = manager.location(
                manager.documentRange.location, offsetBy: lineStarts(h)[line])!
            let frame = manager.textLayoutFragment(for: location)!.layoutFragmentFrame
            return CGPoint(
                x: x, y: h.tv.textContainerInset.top + frame.minY + frame.height * fraction)
        }

        /// A point on the note's empty last line.
        private func trailingLine(_ h: TextFirstHarness) -> CGPoint {
            let manager = h.tv.textLayoutManager!
            let end = manager.location(
                manager.documentRange.location, offsetBy: h.controller.storage.length - 1)!
            let f = manager.textLayoutFragment(for: end)!
            let line = f.textLineFragments.last!
            #expect(line.characterRange.length == 0)
            return CGPoint(
                x: 60,
                y: h.tv.textContainerInset.top + f.layoutFragmentFrame.minY
                    + line.typographicBounds.midY)
        }

        /// The display lines the press at `p` lifts, or nil when it keeps the platform's.
        private func lifted(_ h: TextFirstHarness, at p: CGPoint) -> [Int]? {
            guard let block = h.controller.liftableBlock(at: p) else { return nil }
            return lineStarts(h).enumerated().filter {
                $0.element >= block.location && $0.element < NSMaxRange(block)
            }.map(\.offset)
        }

        @Test func aLongPressLiftsTheBlockUnderTheFingerAndBlankLinesKeepThePlatforms() async {
            // Lines: 0 Head, 1 blank, 2 a, 3 b, 4-6 table, 7 image, 8 quote, 9 end, 10 empty.
            let h = TextFirstHarness(
                "# Head\n\n- a\n  - b\n| x | y |\n|---|---|\n| 1 | 2 |\n![](pic.png) see\n> q\nend\n",
                files: ["pic.png": TextFirstHarness.png(900, 900)])
            #expect(await h.until { h.lineHeights(at: lineStarts(h)[7]).contains { $0 > 100 } })
            #expect(lifted(h, at: point(h, line: 0)) == [0])
            // The page margin left of the text is the line's too.
            #expect(lifted(h, at: point(h, line: 0, x: 4)) == [0])
            #expect(lifted(h, at: point(h, line: 1)) == nil)
            #expect(lifted(h, at: point(h, line: 2)) == [2, 3])
            #expect(lifted(h, at: point(h, line: 3)) == [3])
            // The table's grid lifts the whole table; the image its line.
            #expect(lifted(h, at: point(h, line: 6, x: 40)) == [4, 5, 6])
            #expect(lifted(h, at: point(h, line: 7, x: 70)) == [7])
            #expect(lifted(h, at: point(h, line: 9)) == [9])
            // The note's empty last line lifts nothing (TextKit lays it out in the last
            // paragraph's fragment, under `end`).
            #expect(lifted(h, at: trailingLine(h)) == nil)
            // While a cell is open the whole note keeps the platform's long-press.
            let cell = h.controller.tableCellHit(at: point(h, line: 6, x: 40))!
            h.controller.openCellEditor(cell)
            #expect(lifted(h, at: point(h, line: 0)) == nil)
            h.controller.cellEditor?.finish()
            #expect(lifted(h, at: point(h, line: 0)) == [0])
        }

        @Test func aDropLandsOnTheSlotNearestTheFingerAndNeverBesideItself() throws {
            // Lines: 0 one, 1 two, 2 a, 3 b, 4 three. Line 2 lifts its item with `b`; the list
            // takes nothing between its lines, and its own edges are no slot.
            let h = TextFirstHarness("one\ntwo\n- a\n  - b\nthree")
            let starts = lineStarts(h)
            let block = try #require(h.controller.liftableBlock(at: point(h, line: 2)))
            let targets = try #require(h.controller.dropTargets(line: starts[2], block: block))
            func drop(_ line: Int, _ fraction: CGFloat) -> Int? {
                targets.slot(nearest: point(h, line: line, fraction: fraction).y)?.offset
            }
            let end = h.controller.storage.length
            #expect(drop(0, 0.2) == starts[0])
            #expect(drop(0, 0.8) == starts[1])
            #expect(drop(1, 0.3) == starts[1])
            // Nearer its own top edge, or anywhere over itself: nothing to drop on.
            #expect(drop(1, 0.8) == nil)
            #expect(drop(3, 0.5) == nil)
            #expect(drop(4, 0.3) == nil)
            #expect(drop(4, 0.8) == end)
        }

        @Test func anEmptyNoteKeepsThePlatformsLongPress() {
            let h = TextFirstHarness("")
            #expect(h.controller.liftableBlock(at: CGPoint(x: 60, y: 14)) == nil)
        }
    }
#endif
