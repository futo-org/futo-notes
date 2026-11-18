import UIKit
import XCTest

/// The block drag with real touches while the note scrolls under it (#443): held near an edge
/// the note scrolls and the block lands where the drop line showed.
/// The drop line is read through the debug build's puppet `state` while the finger is held.
final class TextFirstBlockDragAutoscrollUITests: XCTestCase {
    private let lines = (1...150).map { String(format: "line %03d", $0) }

    /// `lines` with display line `from` (1-based) moved above line `before` (0: the note's end).
    private func moving(_ from: Int, before: Int) -> String {
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

    /// Play `finger`, a drag of one of `lines` that ends held still over a drop line, then
    /// check the block landed where that drop line showed and that the line drawn just above
    /// the drop line stayed where it was: the note did not jump. The line lifted and the line
    /// the drop line was above.
    @MainActor
    private func drop(_ finger: TextFirstTouch, in note: TextFirstDragNote) throws -> (
        line: Int, before: Int
    ) {
        let drawn = TextFirstStates()
        let states = try note.puppet.watch(
            while: { try TextFirstTouch.perform([finger]) },
            look: {
                [puppet = note.puppet, lines] state in
                guard let before = state.dropLineBefore, before > 1 else { return }
                let rect = puppet.post("/show", ["text": lines[before - 2]])?["rect"]
                drawn.append(["before": before, "rect": rect ?? NSNull()])
            })
        // The last state seen with the finger down, held still.
        let held = try XCTUnwrap(states.last { $0.blockDrag != nil })
        let line = try XCTUnwrap(held.blockDrag?["line"] as? Int)
        let before = try XCTUnwrap(held.dropLineBefore)
        XCTAssertTrue(note.saved(moving(line, before: before)), "it lands at the drop line")
        let above = lines[before - 2]
        let rect = try XCTUnwrap(drawn.all.last { $0["before"] as? Int == before }?["rect"])
        XCTAssertEqual(
            String(describing: note.puppet.post("/show", ["text": above])?["rect"] ?? "gone"),
            String(describing: rect), "`\(above)`, drawn just above the drop line, stays put")
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
        XCTAssertTrue(note.saved(moving(1, before: before)), "it lands at the drop line")
    }
}
