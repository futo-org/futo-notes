import UIKit
import XCTest

/// The long-press block drag with real touches (#441): with the keyboard down a hold lifts a
/// line and raises no keyboard; while the note is being edited every long-press is the
/// platform's, and a double-tap still selects a word.
final class TextFirstBlockDragUITests: XCTestCase {
    @MainActor
    private func open(_ text: String, files: [String: Data] = [:]) throws -> TextFirstDragNote {
        try TextFirstDragNote.open(text, files: files)
    }

    @MainActor
    func testAHoldLiftsALineOnlyWhileTheKeyboardIsDown() throws {
        let note = try open("alpha\nbravo\ncharlie\ndelta")
        let (app, editor) = (note.app, note.editor)

        // Keyboard down: hold `alpha` past the lift, then carry it below `delta` (the drop
        // line there is the note's end). The lift starts no editing.
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        note.line(0).press(
            forDuration: 0.8, thenDragTo: note.line(3).withOffset(CGVector(dx: 0, dy: 10)),
            withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(
            note.saved("bravo\ncharlie\ndelta\nalpha"), "the held line lands at the drop line")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "a lift does not raise the keyboard")

        note.line(1, x: 40).doubleTap()
        editor.typeText("Z")
        XCTAssertTrue(note.saved("bravo\nZ\ndelta\nalpha"), "a double-tap selects the word it hits")

        // Keyboard up: a hold is the platform's. Its loupe carries the caret to where the
        // finger lets go, at a line's start, and nothing lifts: typing lands there and no line
        // moves (a lift would have carried the line, or left the caret after `Z`). The note
        // before the keystroke already satisfies "no line moved", so the `Y` itself must show
        // up in the saved file, once and at a line's start.
        note.line(0).press(
            forDuration: 0.8, thenDragTo: note.line(2, x: 2), withVelocity: .slow,
            thenHoldForDuration: 0.3)
        editor.typeText("Y")
        XCTAssertTrue(
            note.saved { text in
                let at = text.firstIndex(of: "Y")
                return text.filter { $0 == "Y" }.count == 1
                    && text.replacingOccurrences(of: "Y", with: "") == "bravo\nZ\ndelta\nalpha"
                    && at.map { $0 == text.startIndex || text[text.index(before: $0)] == "\n" }
                        == true
            }, "a long-press while editing places the caret and moves no line")
    }

    /// Right of a last-line emoji, the row's end is two UTF-16 units past the emoji's start;
    /// the press must still name the emoji, not the middle of its surrogate pair.
    @MainActor
    func testAHoldRightOfAnEmojiLiftsItsLine() throws {
        let note = try open("first\n\u{1F642}")
        note.line(1, x: 300).press(
            forDuration: 0.8, thenDragTo: note.line(0).withOffset(CGVector(dx: 0, dy: -12)),
            withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(note.saved("\u{1F642}\nfirst"), "the emoji's line lands above `first`")
    }

    /// A tall photo alone on the note's last line, with no final line ending, lifts its line:
    /// just above the line's top edge the finger is still over the block, so a release there
    /// moves nothing. Carried higher, it lands at the top.
    @MainActor
    func testAPhotoAloneOnTheLastLineDropsNowhereNearItsOwnTop() throws {
        let photo = UIGraphicsImageRenderer(size: CGSize(width: 900, height: 900)).pngData {
            context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 900, height: 900))
        }
        let text = "first\nsecond\n![](pic.png)"
        let note = try open(text, files: ["pic.png": photo])
        // Wait for the photo to load and take its height.
        let top = 4 + 2 * TextFirstDragNote.lineStep
        let onPhoto = note.editor.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: 120, dy: top + 14))
        Thread.sleep(forTimeInterval: 2)
        onPhoto.press(
            forDuration: 0.8, thenDragTo: onPhoto.withOffset(CGVector(dx: 0, dy: -20)),
            withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertFalse(
            note.saved { $0 != text }, "released by its own top edge, the photo's line stays")
        onPhoto.press(
            forDuration: 0.8,
            thenDragTo: note.line(0).withOffset(CGVector(dx: 60, dy: -12)),
            withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(note.saved("![](pic.png)\nfirst\nsecond"), "carried up, it lands at the top")
    }

    /// An empty task on the last line shows its box and no characters, so the boundary above it
    /// and the note's end share a display position (#446): a line carried below the task's row
    /// lands after the task, and the task itself lifts.
    @MainActor
    func testAnEmptyLastTaskLiftsAndADropBelowItLandsAfterIt() throws {
        let after = try open("alpha\nbravo\n- [ ] ")
        after.line(0).press(
            forDuration: 0.8,
            thenDragTo: after.line(2).withOffset(
                CGVector(dx: 0, dy: TextFirstDragNote.lineStep * 0.45)),
            withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(after.saved("bravo\n- [ ] \nalpha"), "dropped below the task, after it")
        after.app.terminate()

        let task = try open("alpha\nbravo\n- [ ] ")
        task.line(2).press(
            forDuration: 0.8, thenDragTo: task.line(0).withOffset(CGVector(dx: 0, dy: -12)),
            withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(task.saved("- [ ] \nalpha\nbravo"), "the empty task lifts and lands on top")
    }
}
