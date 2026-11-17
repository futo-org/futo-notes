#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The long-press block drag's decisions on a laid-out note: which block a press at a point
    /// lifts (or that it keeps the platform's long-press), which slot a finger at a point drops
    /// it on, and when the drop line reaches a new slot. The drag itself is
    /// `TextFirstBlockDragUITests`. Nothing lifts while the note is being edited, so the notes
    /// open with the keyboard down.
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
            guard let block = h.controller.liftPlan(at: p)?.block else { return nil }
            return lineStarts(h).enumerated().filter {
                $0.element >= block.location && $0.element < NSMaxRange(block)
            }.map(\.offset)
        }

        @Test func aLongPressLiftsTheBlockUnderTheFingerAndBlankLinesKeepThePlatforms() async {
            // Lines: 0 Head, 1 blank, 2-4 table, 5 text and a photo, 6 link, 7 end, 8 the empty
            // last line. Which lines a line lifts is the engine's (engine/tests/moves.rs); this
            // is which line a point is.
            let h = TextFirstHarness(
                "# Head\n\n| x | y |\n|---|---|\n| 1 | 2 |\nsee ![](pic.png)\n[link](https://x.y) on\nend\n",
                files: ["pic.png": TextFirstHarness.png(900, 900)])
            #expect(await h.until { h.lineHeights(at: lineStarts(h)[5]).contains { $0 > 100 } })
            // While the note is being edited (the keyboard up, or a hardware keyboard typing
            // into it) nothing lifts: the long-press is the platform's.
            #expect(lifted(h, at: point(h, line: 0)) == nil)
            h.tv.resignFirstResponder()
            #expect(lifted(h, at: point(h, line: 0)) == [0])
            // The page margin left of the text is the line's too.
            #expect(lifted(h, at: point(h, line: 0, x: 4)) == [0])
            #expect(lifted(h, at: point(h, line: 1)) == nil)
            // The table's grid lifts the whole table; an image or a link the block holding it.
            // The photo is too wide to share a row with `see` and is drawn on its own, but it is
            // on `see`'s line, and a press on it lifts that line.
            #expect(lifted(h, at: point(h, line: 4, x: 40)) == [2, 3, 4])
            let photo = h.controller.imageHit(at: point(h, line: 5, x: 70, fraction: 0.7))
            #expect(photo != nil)
            #expect(lifted(h, at: point(h, line: 5, x: 70, fraction: 0.7)) == [5])
            #expect(lifted(h, at: point(h, line: 6, x: 30)) == [6])
            // The note's empty last line lifts nothing (TextKit lays it out in the last
            // paragraph's fragment, under `end`).
            #expect(lifted(h, at: point(h, line: 7)) == [7])
            #expect(lifted(h, at: trailingLine(h)) == nil)
            // While a cell is open the whole note keeps the platform's long-press.
            let cell = h.controller.tableCellHit(at: point(h, line: 4, x: 40))!
            h.controller.openCellEditor(cell)
            #expect(lifted(h, at: point(h, line: 0)) == nil)
            h.controller.cellEditor?.finish()
            // Closing it hands the keyboard back to the body.
            #expect(lifted(h, at: point(h, line: 0)) == nil)
            h.tv.resignFirstResponder()
            #expect(lifted(h, at: point(h, line: 0)) == [0])
            // Any other text input in the window holding focus is editing too (a stand-in for the
            // title and Find fields).
            let field = UITextField(frame: CGRect(x: 0, y: 0, width: 100, height: 30))
            h.window.addSubview(field)
            _ = field.becomeFirstResponder()
            #expect(lifted(h, at: point(h, line: 0)) == nil)
            field.resignFirstResponder()
            #expect(lifted(h, at: point(h, line: 7, x: 300)) == [7])
            // An empty note has nothing to lift.
            let empty = TextFirstHarness("")
            #expect(empty.controller.liftPlan(at: CGPoint(x: 60, y: 14)) == nil)
        }

        @Test func aBlockRunningOffScreenLiftsWhatShows() throws {
            // A code block taller than the screen, scrolled so its top is gone.
            let code = (1...80).map { "code \($0)" }.joined(separator: "\n")
            let h = TextFirstHarness("intro\n```\n\(code)\n```\nafter", focused: false)
            h.tv.layoutIfNeeded()
            h.tv.contentOffset.y = 600
            h.tv.layoutIfNeeded()
            let p = CGPoint(x: 60, y: h.tv.bounds.midY)
            let lift = try #require(h.controller.liftPlan(at: p))
            // Every line between `intro` and `after` (the last line).
            #expect(lifted(h, at: p) == Array(1..<(lineStarts(h).count - 1)))
            // The card is the block's part on screen; its top edge is the screen's.
            #expect(lift.frame.minY == h.tv.bounds.minY)
            #expect(lift.frame.maxY <= h.tv.bounds.maxY)
        }

        @Test func aDropLandsOnTheSlotNearestTheFingerAndNeverBesideItself() throws {
            // Lines: 0 one, 1 two, 2 a, 3 b, 4 three. Line 2 lifts its item with `b`; the list
            // takes nothing between its lines, and its own edges are no slot.
            let h = TextFirstHarness("one\ntwo\n- a\n  - b\nthree", focused: false)
            let starts = lineStarts(h)
            let targets = try #require(h.controller.liftPlan(at: point(h, line: 2))).targets
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

        @Test func theDropLineTicksOnceForEachNewSlotItReaches() throws {
            // `one` lifts alone; its slots are above `three`, above `four` and the note's end.
            let h = TextFirstHarness("one\ntwo\nthree\nfour", focused: false)
            let start = point(h, line: 0)
            let lift = try #require(h.controller.liftPlan(at: start))
            let drag = TextFirstBlockDrag(lift, at: start, snapshot: UIView(), on: h.tv)
            defer { drag.finish(returning: false) }
            let ticks = [
                point(h, line: 0),  // over itself: no drop line
                point(h, line: 1, fraction: 0.8),  // above `three`
                point(h, line: 1, fraction: 0.9),  // still there
                point(h, line: 2, fraction: 0.8),  // above `four`
                point(h, line: 0),  // back over itself
                point(h, line: 2, fraction: 0.8),  // above `four` again
            ].map { drag.follow($0) }
            #expect(ticks == [false, true, false, true, false, true])
        }

        @Test func aMoveLeavesTheViewWithTheEnginesExactUtf16() throws {
            // Line 0 is precomposed `é`, line 1 decomposed `e` and U+0301: Swift calls the two
            // strings equal, but they are one UTF-16 unit apart. Moving line 0 below line 1
            // swaps them; a view that took them for unchanged would no longer match the engine.
            let h = TextFirstHarness("\u{e9}\ne\u{301}\nz", focused: false)
            let slots = try #require(try h.controller.blockSlots(atLineOffset: 0))
            #expect(slots == [5, 6])
            #expect(try h.controller.moveBlock(atLineOffset: 0, toSlot: 5))
            let shown = Array(h.controller.storage.string.utf16)
            #expect(shown == Array("e\u{301}\n\u{e9}\nz".utf16))
            #expect(shown == Array(try h.controller.session.displayText().utf16))
            #expect(h.controller.divergences.isEmpty, "\(h.controller.divergences)")
        }
    }
#endif
