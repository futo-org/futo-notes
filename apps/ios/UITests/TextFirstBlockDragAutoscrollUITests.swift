import UIKit
import XCTest

/// The block drag with real touches while the note scrolls under it, and what ends it early
/// (#443): held near an edge the note scrolls (the live preview hands the drag to the drop line
/// first, #448) and the block lands where the drop line showed; a change to the note's text,
/// the app leaving the foreground, or a second finger.
/// What is drawn is read through the debug build's puppet `state` while the finger is held.
final class TextFirstBlockDragAutoscrollUITests: XCTestCase {
    private let lines = (1...150).map { String(format: "line %03d", $0) }

    /// `lines` with display line `from` (1-based) moved above line `before` (0: the note's end).
    private func moving(_ from: Int, before: Int, in lines: [String]) -> String {
        var moved = lines
        let block = moved.remove(at: from - 1)
        let to = before == 0 ? moved.count : (before > from ? before - 2 : before - 1)
        moved.insert(block, at: to)
        return moved.joined(separator: "\n")
    }

    @MainActor
    func testHeldAtTheBottomTheNoteScrollsAndTheBlockLandsWhereTheDropLineShowed() throws {
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(dy: note.editor.frame.height - 50), over: 0.5).hold(2)
            .move(to: note.screen(dy: note.editor.frame.height / 2), over: 0.4).hold(0.8).lift()
        let held = try drop(finger, in: note)
        XCTAssertEqual(held.line, 1)
        XCTAssertGreaterThan(held.before, 60, "the note scrolled well past the first screen")
    }

    /// Carried on screen the note shows the move live; held at the bottom edge, what slid slides
    /// back and the curtain comes down before the note scrolls, and the drop line takes over.
    @MainActor
    func testTheAutoscrollTakesOverFromThePreviewAfterItIsDown() throws {
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        let finger = TextFirstTouch(down: note.screen(line: 1)).hold(0.6)
            .move(to: note.screen(line: 6), over: 0.4).hold(0.8)
            .move(to: note.screen(dy: note.editor.frame.height - 30), over: 0.4).hold(2)
            .move(to: note.screen(dy: note.editor.frame.height / 2), over: 0.4).hold(0.8).lift()
        let seen = TextFirstStates()
        let held = try drop(finger, in: note, seen: seen)
        XCTAssertEqual(held.line, 2)
        let states = seen.all.filter { $0.blockDrag != nil }
        XCTAssertTrue(states.contains { $0.reflowOpen }, "it was previewed first")
        let start = try XCTUnwrap(states.first?.blockDrag?["scrollY"] as? Double)
        XCTAssertTrue(
            states.filter(\.dragPreview).allSatisfy {
                $0.blockDrag?["scrollY"] as? Double == start
            },
            "nothing scrolls under the curtain")
        XCTAssertTrue(states.contains { $0.preview == "dropLine" && $0.dropLineY != nil })
    }

    @MainActor
    func testHeldAtTheTopTheNoteScrollsUpAndTheBlockLandsWhereTheDropLineShowed() throws {
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        XCTAssertNotNil(note.puppet.post("/do/ScrollToLine", ["line": 150]))
        let middle = note.screen(dy: note.editor.frame.height / 2)
        let finger = TextFirstTouch(down: middle).hold(0.6)
            .move(to: note.screen(dy: 30), over: 0.5).hold(1.5)
            .move(to: middle, over: 0.4).hold(0.8).lift()
        let held = try drop(finger, in: note)
        XCTAssertGreaterThan(held.line, 100)
        XCTAssertLessThan(held.before, held.line - 40, "it scrolled up past the lift's screen")
    }

    @MainActor
    func testABlockTallerThanTheScreenLeavesFromAboveAndTheScreenHoldsStill() throws {
        // One paragraph wrapping to about fifty rows, then short lines.
        let tall = Array(repeating: "a paragraph taller than the screen", count: 60)
            .joined(separator: " ")
        let lines = [tall] + self.lines
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(dy: note.editor.frame.height - 50), over: 0.5).hold(2.5)
            .move(to: note.screen(dy: note.editor.frame.height / 2), over: 0.4).hold(0.8).lift()
        let held = try drop(finger, in: note, lines: lines)
        XCTAssertEqual(held.line, 1)
        XCTAssertGreaterThan(held.before, 20, "it went past the paragraph's own end")
    }

    @MainActor
    func testReleasedWithoutAPauseTheBlockLandsUnderTheFinger() throws {
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        // Carried down by the autoscroll, then brought up mid-screen and let go at once.
        let release = note.screen(dy: note.editor.frame.height / 2 + 7)
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(dy: note.editor.frame.height - 50), over: 0.5).hold(1.5)
            .move(to: release, over: 0.3).lift()
        try TextFirstTouch.perform([finger])
        XCTAssertTrue(note.saved { !$0.hasPrefix("line 001") }, "it moved")
        // The block left from above the screen, which held still: `line 001` is drawn on the
        // boundary nearest where the finger let go.
        let landed = try XCTUnwrap(
            note.puppet.post("/show", ["text": "line 001"])?["rect"] as? [String: Int])
        let top = CGFloat(try XCTUnwrap(landed["y"]))
        XCTAssertLessThanOrEqual(abs(top - release.y), TextFirstDragNote.lineStep / 2 + 3)
    }

    /// Play `finger`, a drag of one of `lines` that ends held still over a drop line, then
    /// check the drop line was drawn between the line above it and the line it shows the
    /// block landing above, that the block landed there, and that the line drawn just above
    /// the drop line stayed where it was: the note did not jump. The line lifted and the line
    /// the drop line was above.
    @MainActor
    private func drop(
        _ finger: TextFirstTouch, in note: TextFirstDragNote, lines: [String]? = nil,
        seen: TextFirstStates? = nil
    ) throws -> (line: Int, before: Int) {
        let lines = lines ?? self.lines
        let drawn = TextFirstStates()
        let states = try note.puppet.watch(
            while: { try TextFirstTouch.perform([finger]) },
            look: {
                [puppet = note.puppet, lines] state in
                seen?.append(state)
                guard let before = state.dropLineBefore, before > 1, let y = state.dropLineY
                else { return }
                let above = puppet.post("/show", ["text": lines[before - 2]])?["rect"]
                let below = puppet.post("/show", ["text": lines[before - 1]])?["rect"]
                drawn.append([
                    "before": before, "y": y, "above": above ?? NSNull(),
                    "slotY": state.blockDrag?["landsY"] ?? NSNull(),
                    "below": below ?? NSNull(),
                ])
            })
        // The last state seen with the finger down, held still.
        let held = try XCTUnwrap(states.last { $0.blockDrag != nil })
        let line = try XCTUnwrap(held.blockDrag?["line"] as? Int)
        let before = try XCTUnwrap(held.dropLineBefore)
        let seen = try XCTUnwrap(drawn.all.last { $0["before"] as? Int == before })
        let above = try XCTUnwrap(seen["above"] as? [String: Int])
        let below = try XCTUnwrap(seen["below"] as? [String: Int])
        let y = try XCTUnwrap(seen["y"] as? Double)
        // The drop line is on its slot's boundary as the note is laid out now: both read in one
        // request (`/show`'s text rects are separate requests, rounded to whole points).
        let slotY = try XCTUnwrap(seen["slotY"] as? Double)
        XCTAssertEqual(y, slotY, accuracy: 0.5, "the drop line is on its boundary as laid out")
        XCTAssertTrue(
            Double(above["y"]!) < y && y <= Double(below["y"]!) + 1,
            "the drop line (\(y)) is drawn between \(above) and \(below)")
        XCTAssertTrue(
            note.saved(moving(line, before: before, in: lines)), "it lands at the drop line")
        XCTAssertEqual(
            note.puppet.post("/show", ["text": lines[before - 2]])?["rect"] as? [String: Int],
            above, "`\(lines[before - 2])`, drawn just above the drop line, stays put")
        return (line, before)
    }

    @MainActor
    func testHeldStillInTheZoneTheNoteScrollsToItsEndAndStops() throws {
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(dy: note.editor.frame.height - 30), over: 0.5).hold(6).lift()
        let states = try note.puppet.watch { try TextFirstTouch.perform([finger]) }
        let dragging = states.filter { $0.blockDrag != nil }
        // Over the hold's last second the finger and the note are both still, at the note's end.
        let last = dragging.suffix(15)
        XCTAssertEqual(last.count, 15)
        let ends = last.map(\.lastLineOnScreen)
        XCTAssertTrue(ends.allSatisfy { $0 == 150 }, "\(ends)")
        XCTAssertEqual(Set(last.map { $0.firstLineOnScreen ?? -1 }).count, 1, "it stopped")
        let before = try XCTUnwrap(last.last?.dropLineBefore)
        XCTAssertTrue(note.saved(moving(1, before: before, in: lines)), "it lands at the drop line")
    }

    @MainActor
    func testATextChangeWhileHeldCancelsTheDragAtOnce() throws {
        let text = "alpha\nbravo\ncharlie\ndelta\necho"
        let note = try TextFirstDragNote.open(text)
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(line: 3), over: 0.4).hold(2.5)
            .move(to: note.screen(line: 4), over: 0.3).hold(0.3).lift()
        let changed = TextFirstStates()
        let states = try note.puppet.watch(
            while: { try TextFirstTouch.perform([finger]) },
            look: {
                [puppet = note.puppet] state in
                // As a sync would, once the block is held over a gap the preview opened.
                guard changed.all.isEmpty, state.reflowOpen, state.landsBefore != nil else {
                    return
                }
                changed.append(puppet.post("/do/Insert", ["text": "!", "after": "echo"]) ?? [:])
            })
        XCTAssertEqual(changed.all.first?["ok"] as? Bool, true)
        // From the change on no state shows the drag or its preview, though the finger stayed
        // down for seconds more (polled every 50 ms; the watch ends as the finger lifts).
        let shown = try XCTUnwrap(states.lastIndex { $0.blockDrag != nil || $0.dragPreview })
        XCTAssertGreaterThan(states.count - shown - 1, 20)
        XCTAssertTrue(note.saved(text + "!"), "the change lands and nothing moved")
        XCTAssertFalse(note.saved({ $0 != text + "!" }, within: 1.5))
    }

    @MainActor
    func testLeavingTheAppWhileHeldCancelsTheDrag() throws {
        let text = "alpha\n[site](https://example.com)\ncharlie\ndelta"
        let note = try TextFirstDragNote.open(text)
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(line: 3), over: 0.4).hold(2.5).lift()
        let left = TextFirstStates()
        _ = try note.puppet.watch(
            while: { try TextFirstTouch.perform([finger]) },
            look: {
                [puppet = note.puppet] state in
                // Another app comes to the front (Safari, for the link) while the block is held.
                guard left.all.isEmpty, state.landsBefore != nil else { return }
                left.append(puppet.post("/do/OpenLink", ["find": "site"]) ?? [:])
            })
        XCTAssertEqual(left.all.first?["ok"] as? Bool, true)
        XCTAssertNotEqual(note.app.state, .runningForeground)
        note.app.activate()
        XCTAssertTrue(note.app.wait(for: .runningForeground, timeout: 10))
        XCTAssertFalse(note.saved({ $0 != text }, within: 2), "nothing moved")
        let after = try XCTUnwrap(note.puppet.editor())
        XCTAssertNil(after.blockDrag)
        XCTAssertFalse(after.dragPreview)
    }

    @MainActor
    func testASecondFingerWhileHeldIsIgnored() throws {
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        // The first finger holds still over line 7 from 0.9 s to 3.1 s.
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(line: 6), over: 0.3).hold(2.2).lift()
        // Meanwhile another finger comes down on a line, rests, then swipes as if to scroll.
        // (One other finger: the simulator's digitizer has two touch points.)
        let other = TextFirstTouch(down: note.screen(line: 14, x: 250), at: 1.3).hold(0.3)
            .move(to: note.screen(line: 4, x: 250), over: 0.3).lift()
        let since = try XCTUnwrap(note.puppet.post("/touches")?["last"] as? Int)
        let states = try note.puppet.watch { try TextFirstTouch.perform([finger, other]) }
        let landed = note.puppet.post("/touches", ["since": since])?["touches"] as? [Any]
        XCTAssertGreaterThanOrEqual(landed?.count ?? 0, 2, "the app got both fingers")
        // While the first finger is still, nothing the drag draws moves: not the card, the
        // gap or the copy in it, or the scroll, and no caret or selection appears.
        let still = states.filter { (1.1...2.9).contains($0["t"] as? Double ?? 0) }
        XCTAssertGreaterThan(still.count, 20)
        XCTAssertTrue(still.allSatisfy { $0.blockDrag != nil })
        let looks = Set(still.map(\.dragLook))
        XCTAssertEqual(looks.count, 1, "\(looks)")
        let before = try XCTUnwrap(still.last?.landsBefore)
        XCTAssertTrue(note.saved(moving(1, before: before, in: lines)))
        XCTAssertFalse(note.app.keyboards.firstMatch.exists, "the second finger placed no caret")
    }
}
