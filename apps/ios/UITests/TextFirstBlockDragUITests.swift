import UIKit
import XCTest

/// The long-press block drag with real touches (#441): with the keyboard down a hold lifts a
/// line and raises no keyboard; while the note is being edited every long-press is the
/// platform's, and a double-tap still selects a word.
final class TextFirstBlockDragUITests: XCTestCase {
    /// A note open in the editor, with the keyboard down, and its file on disk.
    private struct Opened {
        let app: XCUIApplication
        let editor: XCUIElement
        let file: URL

        /// A point on plain body line `index`: a 4 pt inset, then the body font's line plus
        /// 4 pt spacing each.
        func line(_ index: Int, x: CGFloat = 60) -> XCUICoordinate {
            let y = 4 + (CGFloat(index) + 0.5) * Self.lineStep
            return editor.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: x, dy: y))
        }

        static let lineStep = UIFont.systemFont(ofSize: 17).lineHeight + 4

        func saved(_ matches: @escaping (String) -> Bool) -> Bool {
            let landed = XCTNSPredicateExpectation(
                predicate: NSPredicate { _, _ in
                    (try? String(contentsOf: file, encoding: .utf8)).map(matches) ?? false
                }, object: nil)
            return XCTWaiter.wait(for: [landed], timeout: 5) == .completed
        }

        func saved(_ text: String) -> Bool { saved { $0 == text } }
    }

    /// Open `text` as `drag.md` in a fresh vault holding `files` beside it.
    @MainActor
    private func open(_ text: String, files: [String: Data] = [:]) throws -> Opened {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("text-first-block-drag-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("drag.md")
        try text.write(to: file, atomically: true, encoding: .utf8)
        for (name, data) in files { try data.write(to: root.appendingPathComponent(name)) }
        let app = makeIsolatedApplication()
        app.launchEnvironment["FUTO_NOTES_DATA_DIR"] = root.path
        app.launchArguments += ["-AppleLanguages", "(en)"]
        app.launch()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "drag"))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        let editor = app.textViews["text-first-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        return Opened(app: app, editor: editor, file: file)
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
        let top = 4 + 2 * Opened.lineStep
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
}
