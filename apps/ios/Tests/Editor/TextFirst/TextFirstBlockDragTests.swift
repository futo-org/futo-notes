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

        @Test func aLongPressLiftsTheBlockUnderTheFingerAndBlankLinesKeepThePlatforms()
            async throws
        {
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
            // The table's grid lifts the whole table; a link the block holding it. The photo is
            // too wide to share a row with `see` and is drawn on its own: a press on it lifts the
            // photo alone, a press on `see` the whole line, photo included.
            #expect(lifted(h, at: point(h, line: 4, x: 40)) == [2, 3, 4])
            let onPhoto = point(h, line: 5, x: 70, fraction: 0.7)
            let photo = try #require(h.controller.imageHit(at: onPhoto))
            #expect(h.controller.liftPlan(at: onPhoto)?.block == photo)
            #expect(lifted(h, at: point(h, line: 5, x: 20, fraction: 0.02)) == [5])
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

        @Test func aPhotoSharingItsLineLiftsAloneAndDropsJustBelowIt() async throws {
            // As the maintainer's `Nice!![](…)`: text, then a photo too wide to share its row.
            let h = TextFirstHarness(
                "Nice! Nice! Nice! Nice!![](pic.png)\nnext",
                files: ["pic.png": TextFirstHarness.png(900, 900)], focused: false)
            #expect(await h.until { h.lineHeights(at: 0).contains { $0 > 100 } })
            let onPhoto = point(h, line: 0, x: 70, fraction: 0.7)
            let lift = try #require(h.controller.liftPlan(at: onPhoto))
            #expect(lift.block == NSRange(location: 23, length: 12))
            // The card is the photo, not `Nice!`'s row above it.
            #expect(lift.frame.contains(onPhoto))
            #expect(lift.frame.minY > point(h, line: 0, fraction: 0.02).y)
            #expect(lift.frame.height > 100)
            // Beside the photo on its row, off it, the finger is on the line: it lifts whole.
            for x in [lift.frame.minX - 2, lift.frame.maxX + 20] {
                let beside = point(h, line: 0, x: x, fraction: 0.7)
                #expect(h.controller.imageHit(at: beside) == nil)
                #expect(lifted(h, at: beside) == [0], "x \(x)")
            }
            // Held where it was, it drops nowhere; just below its line it lands above `next`,
            // above `Nice!` it lands at the note's top.
            #expect(lift.targets.slot(nearest: lift.frame.midY) == nil)
            #expect(lift.targets.slot(nearest: lift.frame.maxY + 2)?.slot.offset == 36)
            #expect(lift.targets.slot(nearest: point(h, line: 0, fraction: 0).y)?.slot.offset == 0)
            #expect(
                try h.controller.moveBlock(
                    at: lift.offset, to: TextFirstBlockSlot(offset: 36, end: false)))
            let moved = try h.controller.session.sourceText()
            #expect(moved == "Nice! Nice! Nice! Nice!\n![](pic.png)\nnext")
            #expect(h.controller.divergences.isEmpty, "\(h.controller.divergences)")
        }

        @Test func aPressRightOfALastEmojiLiftsItsLine() throws {
            // TextKit gives the row's end right of the emoji; one UTF-16 unit back is the middle
            // of its surrogate pair, which the engine cannot read.
            for note in ["first\n\u{1F642}", "first\n\u{1F642}\nlast", "first\nab\u{1F642}"] {
                let h = TextFirstHarness(note, focused: false)
                #expect(lifted(h, at: point(h, line: 1, x: 300)) == [1], "\(note)")
            }
        }

        @Test func aPhotoAloneOnTheLastLineLiftsItsLineWithTheLinesEdges() async throws {
            // Without a final line ending the photo's range is its whole line's: the engine lifts
            // the line, so the card and the edges a drop there would not move are the line's.
            let h = TextFirstHarness(
                "first\nsecond\n![](pic.png)", files: ["pic.png": TextFirstHarness.png(900, 900)],
                focused: false)
            #expect(await h.until { h.lineHeights(at: 13).contains { $0 > 100 } })
            let onPhoto = point(h, line: 2, x: 70, fraction: 0.5)
            let photo = try #require(h.controller.imageAt(onPhoto))
            let lift = try #require(h.controller.liftPlan(at: onPhoto))
            #expect(lift.block == NSRange(location: 13, length: 12))
            #expect(lift.block == photo.range)
            // The card is the line, page-wide, not the photo cropped.
            #expect(lift.frame.minX == 0 && lift.frame.width == h.tv.bounds.width)
            // Just inside its top edge or bottom, the finger is over the block's own edge: no
            // drop line, and above `second` only once the finger is nearer that boundary.
            #expect(lift.targets.slot(nearest: lift.frame.minY + 4) == nil)
            #expect(lift.targets.slot(nearest: lift.frame.maxY - 4) == nil)
            let aboveSecond = lift.targets.slot(nearest: point(h, line: 1, fraction: 0.2).y)
            #expect(aboveSecond?.slot.offset == 6)
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
                targets.slot(nearest: point(h, line: line, fraction: fraction).y)?.slot.offset
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

        @Test func anEmptyTaskOnTheLastLineLiftsAndADropAfterItLandsAfterIt() throws {
            // The task draws a box and no characters: the display is `a\nb\n`, and the
            // boundary above the task and the note's end are both at 4, drawn at the top and
            // the bottom of the task's row.
            let h = TextFirstHarness("a\nb\n- [ ] ", focused: false)
            let task = try #require(h.controller.liftPlan(at: trailingLine(h)))
            #expect(task.block == NSRange(location: 4, length: 0))
            #expect(task.frame.height > 10)
            #expect(task.frame.contains(CGPoint(x: 60, y: trailingLine(h).y)))
            // Over its own row it drops nowhere; above `b` it lands there.
            #expect(task.targets.slot(nearest: task.frame.midY) == nil)
            let aboveB = task.targets.slot(nearest: point(h, line: 1, fraction: 0.2).y)
            #expect(aboveB?.slot == TextFirstBlockSlot(offset: 2, end: false))
            // `a` may land above the task or after it, two targets one row apart.
            let a = try #require(h.controller.liftPlan(at: point(h, line: 0)))
            let above = TextFirstBlockSlot(offset: 4, end: false)
            let end = TextFirstBlockSlot(offset: 4, end: true)
            let ys = Dictionary(uniqueKeysWithValues: a.targets.slots.map { ($0.slot, $0.y) })
            let (top, bottom) = (try #require(ys[above]), try #require(ys[end]))
            #expect(top == task.frame.minY && bottom == task.frame.maxY)
            #expect(a.targets.slot(nearest: bottom + 2)?.slot == end)
            #expect(try h.controller.moveBlock(at: a.offset, to: end))
            #expect(try h.controller.session.sourceText() == "b\n- [ ] \na")
            #expect(h.controller.divergences.isEmpty, "\(h.controller.divergences)")
        }

        @Test func aMoveLeavesTheViewWithTheEnginesExactUtf16() throws {
            // Line 0 is precomposed `é`, line 1 decomposed `e` and U+0301: Swift calls the two
            // strings equal, but they are one UTF-16 unit apart. Moving line 0 below line 1
            // swaps them; a view that took them for unchanged would no longer match the engine.
            let h = TextFirstHarness("\u{e9}\ne\u{301}\nz", focused: false)
            let slots = try h.controller.blockSlots(at: 0)
            let above = TextFirstBlockSlot(offset: 5, end: false)
            #expect(slots == [above, TextFirstBlockSlot(offset: 6, end: true)])
            #expect(try h.controller.moveBlock(at: 0, to: above))
            let shown = Array(h.controller.storage.string.utf16)
            #expect(shown == Array("e\u{301}\n\u{e9}\nz".utf16))
            #expect(shown == Array(try h.controller.session.displayText().utf16))
            #expect(h.controller.divergences.isEmpty, "\(h.controller.divergences)")
        }
    }
#endif
