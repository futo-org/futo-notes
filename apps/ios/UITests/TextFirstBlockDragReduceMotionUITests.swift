import UIKit
import XCTest

/// The block drag with Reduce Motion on (the debug build's `-FUTODebugReduceMotion`), carried
/// far by the autoscroll: the drop line shows where it lands, and the screen holds still at the
/// drop (447e63909's anchor, the line above the drop line). Read through the puppet `state`.
final class TextFirstBlockDragReduceMotionUITests: XCTestCase {
    private let lines = (1...150).map { String(format: "line %03d", $0) }

    @MainActor
    func testABlockTallerThanTheScreenCarriedFarLandsAtTheDropLineAndTheScreenHoldsStill()
        throws
    {
        // One paragraph wrapping to about fifty rows, then short lines.
        let tall = Array(repeating: "a paragraph taller than the screen", count: 60)
            .joined(separator: " ")
        let lines = [tall] + self.lines
        let note = try TextFirstDragNote.open(
            lines.joined(separator: "\n"), arguments: ["-FUTODebugReduceMotion"])
        let height = note.editor.frame.height
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(dy: height - 50), over: 0.5).hold(2.5)
            .move(to: note.screen(dy: height / 2), over: 0.4).hold(0.8).lift()
        // While held: where the drop line is drawn, and the lines either side of it.
        let drawn = TextFirstStates()
        let states = try note.puppet.watch(
            while: { try TextFirstTouch.perform([finger]) },
            look: {
                [puppet = note.puppet, lines] state in
                guard let before = state.dropLineBefore, before > 1, let y = state.dropLineY
                else { return }
                let above = puppet.post("/show", ["text": lines[before - 2]])?["rect"]
                let below = puppet.post("/show", ["text": lines[before - 1]])?["rect"]
                drawn.append([
                    "before": before, "y": y, "above": above ?? NSNull(),
                    "slotY": state.blockDrag?["landsY"] ?? NSNull(), "below": below ?? NSNull(),
                ])
            })
        let held = try XCTUnwrap(states.last { $0.blockDrag != nil })
        XCTAssertEqual(held.preview, "dropLine")
        XCTAssertFalse(states.contains { $0.dragPreview }, "nothing slid")
        XCTAssertEqual(held.blockDrag?["line"] as? Int, 1)
        let before = try XCTUnwrap(held.dropLineBefore)
        XCTAssertGreaterThan(before, 20, "it went past the paragraph's own end")
        let seen = try XCTUnwrap(drawn.all.last { $0["before"] as? Int == before })
        let above = try XCTUnwrap(seen["above"] as? [String: Int])
        let below = try XCTUnwrap(seen["below"] as? [String: Int])
        let y = try XCTUnwrap(seen["y"] as? Double)
        // On its slot's boundary as laid out (both read in one request), between the lines.
        XCTAssertEqual(y, try XCTUnwrap(seen["slotY"] as? Double), accuracy: 0.5)
        XCTAssertTrue(
            Double(above["y"]!) < y && y <= Double(below["y"]!) + 1,
            "the drop line (\(y)) is drawn between \(above) and \(below)")
        XCTAssertTrue(note.saved(lines.moving(1, before: before)), "it lands at the drop line")
        XCTAssertEqual(
            note.puppet.post("/show", ["text": lines[before - 2]])?["rect"] as? [String: Int],
            above, "`\(lines[before - 2])`, drawn just above the drop line, stays put")
    }
}
