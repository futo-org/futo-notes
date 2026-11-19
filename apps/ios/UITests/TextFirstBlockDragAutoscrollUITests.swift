import UIKit
import XCTest

/// The block drag with real touches while the note scrolls under it, and what ends it early
/// (#443): held near an edge the note scrolls under the live preview (#449) and the block lands
/// where the preview showed it; a change to the note's text, the app leaving the foreground, or
/// a second finger.
/// What is drawn is read through the debug build's puppet `state` while the finger is held.
final class TextFirstBlockDragAutoscrollUITests: XCTestCase {
    private let lines = (1...150).map { String(format: "line %03d", $0) }

    @MainActor
    func testHeldAtTheBottomTheNoteScrollsAndTheBlockLandsWhereThePreviewShowed() throws {
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(dy: note.editor.frame.height - 50), over: 0.5).hold(2)
            .move(to: note.screen(dy: note.editor.frame.height / 2), over: 0.4).hold(0.8).lift()
        let held = try landed(note.puppet.watch { try TextFirstTouch.perform([finger]) }, in: note)
        XCTAssertEqual(held.line, 1)
        XCTAssertGreaterThan(held.before, 60, "the note scrolled well past the first screen")
    }

    /// Carried down more than two screens, the note shows the move live all the way (#449): no
    /// drop line; under the still finger the gap moves on without a tick; the copy in the gap
    /// and the line above it are drawn. The drop lands where the preview showed it.
    @MainActor
    func testCarriedMoreThanTwoScreensThePreviewHoldsAndTheDropLandsWhereItShowed() throws {
        // The lifted line draws far right of where any other line's words end.
        var lines = self.lines
        lines[0] = "lifted ██████████"
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        let height = note.editor.frame.height
        // Off to the right, so the card rides clear of the copy's words.
        let finger = TextFirstTouch(down: note.screen(line: 0)).hold(0.6)
            .move(to: note.screen(x: 330, dy: height - 30), over: 0.5).hold(3)
            .move(to: note.screen(x: 330, dy: height / 2), over: 0.4).hold(1.2).lift()
        var look: [String: Any] = [:]
        var shot: XCUIScreenshot?
        let began = Date()
        let states = try note.puppet.watch {
            try TextFirstTouch.perform([finger]) {
                Thread.sleep(forTimeInterval: max(0, 5.2 - Date().timeIntervalSince(began)))
                look = note.puppet.editor() ?? [:]
                shot = XCUIScreen.main.screenshot()
            }
        }
        let held = try landed(states, in: note, lines: lines)
        XCTAssertEqual(held.line, 1)
        let dragging = states.filter { $0.blockDrag != nil }
        XCTAssertTrue(dragging.allSatisfy { $0.preview == "reflow" && $0.dropLineY == nil })
        let scrolls = dragging.compactMap { $0.blockDrag?["scrollY"] as? Double }
        XCTAssertGreaterThan((scrolls.max() ?? 0) - (scrolls.min() ?? 0), 2 * height)
        let still = dragging.filter { (1.3...3.9).contains($0["t"] as? Double ?? 0) }
        XCTAssertGreaterThan(Set(still.compactMap(\.landsBefore)).count, 10, "the gap moved on")
        let ticks = Set(still.compactMap { $0.blockDrag?["ticks"] as? Int })
        XCTAssertEqual(ticks.count, 1, "no tick while the note scrolls: \(ticks)")
        // Drawn in the gap, clear of the card: the lifted line's own words, dimmed, out to where
        // no other line's reach; and the line above it.
        let image = try XCTUnwrap(shot).image
        let add = XCTAttachment(screenshot: try XCTUnwrap(shot))
        (add.name, add.lifetime) = ("long-drag-held", .keepAlways)
        self.add(add)
        let copy = try XCTUnwrap(look.copyRect)
        let card = try XCTUnwrap(look.blockDrag?["card"] as? [String: Int])
        let left = note.editor.frame.minX + 8
        let row = CGRect(
            x: left, y: CGFloat(copy["y"]!), width: CGFloat(card["x"]! - 20) - left,
            height: CGFloat(copy["h"]!))
        let beyond = row.divided(atDistance: 120, from: .minXEdge)
        let dimmed = TextFirstBlockReflowUITests.dark(image, in: beyond.remainder, below: 600)
        XCTAssertGreaterThan(dimmed, 200, "the lifted line's blocks, out past other words")
        XCTAssertEqual(TextFirstBlockReflowUITests.dark(image, in: row), 0, "dimmed, not solid")
        let above = row.offsetBy(dx: 0, dy: -TextFirstDragNote.lineStep)
        XCTAssertGreaterThan(TextFirstBlockReflowUITests.dark(image, in: above), 30)
    }

    /// A nested item carried to the note's foot and dropped there, outside its list, arrives at
    /// the margin, fewer rows tall: the note comes out shorter, and the screen settles at its
    /// new foot, with nothing blank below it to spring back.
    @MainActor
    func testCarriedToTheFootANoteLeftShorterSettlesAtItsFoot() throws {
        let long = Array(repeating: "a nested item", count: 9).joined(separator: " ")
        let lines = ["- top", "  - \(long)"] + self.lines
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        let height = note.editor.frame.height
        // Held in the zone until the foot shows, the gap at the note's end, and let go there.
        let finger = TextFirstTouch(down: note.screen(line: 1)).hold(0.6)
            .move(to: note.screen(dy: height - 30), over: 0.5).hold(6).lift()
        let states = try note.puppet.watch { try TextFirstTouch.perform([finger]) }
        let held = try landed(
            states, in: note, lines: lines, arriving: "- \(long)", holds: false)
        XCTAssertEqual(held.line, 2)
        XCTAssertEqual(held.before, 0, "it lands at the note's end")
        // Shorter, the note's foot came up: the screen is at it, not past it.
        let dragged = try XCTUnwrap(
            states.last { $0.blockDrag != nil }?["scroll"] as? [String: Double])
        let scroll = try XCTUnwrap(note.puppet.editor()?["scroll"] as? [String: Double])
        XCTAssertLessThan(scroll["foot"]!, dragged["foot"]! - 10, "the note is shorter")
        XCTAssertEqual(scroll["y"]!, scroll["foot"]!, accuracy: 0.5, "at its foot")
    }

    @MainActor
    func testHeldAtTheTopTheNoteScrollsUpAndTheBlockLandsWhereThePreviewShowed() throws {
        let note = try TextFirstDragNote.open(lines.joined(separator: "\n"))
        XCTAssertNotNil(note.puppet.post("/do/ScrollToLine", ["line": 150]))
        let middle = note.screen(dy: note.editor.frame.height / 2)
        let finger = TextFirstTouch(down: middle).hold(0.6)
            .move(to: note.screen(dy: 30), over: 0.5).hold(1.5)
            .move(to: middle, over: 0.4).hold(0.8).lift()
        let held = try landed(note.puppet.watch { try TextFirstTouch.perform([finger]) }, in: note)
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
        let states = try note.puppet.watch { try TextFirstTouch.perform([finger]) }
        let held = try landed(states, in: note, lines: lines)
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

    /// The drop seen in `states` landed where the preview showed it as the finger was last held
    /// (no drop line): the note saved with the block, `arriving` as it does, above the line
    /// the gap was above, the block drawn where the copy was, and the line drawn just above the
    /// gap where the preview drew it: nothing jumped (unless the screen cannot have `holds`
    /// still). The line lifted and the line it landed above (1-based; 0 for the note's end).
    @MainActor
    private func landed(
        _ states: [[String: Any]], in note: TextFirstDragNote, lines: [String]? = nil,
        arriving: String? = nil, holds: Bool = true
    ) throws -> (line: Int, before: Int) {
        let lines = lines ?? self.lines
        let held = try XCTUnwrap(states.last { $0.blockDrag != nil })
        XCTAssertEqual(held.preview, "reflow")
        XCTAssertNil(held.dropLineY, "no drop line with the preview")
        let line = try XCTUnwrap(held.blockDrag?["line"] as? Int)
        let before = try XCTUnwrap(held.landsBefore)
        let copy = try XCTUnwrap(held.copyRect)
        XCTAssertTrue(
            note.saved(lines.moving(line, before: before, arriving: arriving)),
            "it lands where the gap was")
        // A body line's words start 4 pt below its top, a list item's at it (all rounded to
        // whole points); the copy's top is the gap's.
        func show(_ text: String) -> [String: Any]? {
            // A paragraph far taller than the screen by its start.
            let words = text.replacingOccurrences(of: "- ", with: "")
                .trimmingCharacters(in: .whitespaces)
            return note.puppet.post("/show", ["text": String(words.prefix(160))])
        }
        func words(_ text: String) -> Int? { (show(text)?["rect"] as? [String: Int])?["y"] }
        let gap = copy["y"]!
        let moved = arriving ?? lines[line - 1]
        guard holds else { return (line, before) }
        if let block = words(moved) {
            XCTAssertTrue((gap - 2...gap + 6) ~= block, "drawn at \(block), copy \(copy)")
        } else {
            XCTAssertLessThan(gap, 0, "only a block off screen is not shown: \(show(moved) ?? [:])")
        }
        var above = before == 0 ? lines.count : before - 1
        if above == line { above -= 1 }
        let step = Int(TextFirstDragNote.lineStep.rounded())
        if above >= 1, CGFloat(gap - step) >= note.editor.frame.minY {
            let y = try XCTUnwrap(words(lines[above - 1]), "\(show(lines[above - 1]) ?? [:])")
            let expected = gap - step + 4
            XCTAssertLessThanOrEqual(abs(y - expected), 2, "`\(lines[above - 1])` at \(y)")
        }
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
        let before = try XCTUnwrap(last.last?.landsBefore)
        XCTAssertTrue(note.saved(lines.moving(1, before: before)), "it lands at the gap")
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
        XCTAssertTrue(note.saved(lines.moving(1, before: before)))
        XCTAssertFalse(note.app.keyboards.firstMatch.exists, "the second finger placed no caret")
    }
}
