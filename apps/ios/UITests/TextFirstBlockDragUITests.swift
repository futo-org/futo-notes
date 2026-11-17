import UIKit
import XCTest

/// The long-press block drag with real touches (#441): with the keyboard down a hold lifts a
/// line and raises no keyboard; while the note is being edited every long-press is the
/// platform's, and a double-tap still selects a word.
final class TextFirstBlockDragUITests: XCTestCase {
    @MainActor
    func testAHoldLiftsALineOnlyWhileTheKeyboardIsDown() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("text-first-block-drag-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("drag.md")
        try "alpha\nbravo\ncharlie\ndelta".write(to: file, atomically: true, encoding: .utf8)
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
        // Plain body lines: 4 pt inset, then the body font's line plus 4 pt spacing each.
        func line(_ index: Int, x: CGFloat = 60) -> XCUICoordinate {
            let y = 4 + (CGFloat(index) + 0.5) * (UIFont.systemFont(ofSize: 17).lineHeight + 4)
            return editor.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: x, dy: y))
        }
        func saved(_ matches: @escaping (String) -> Bool) -> Bool {
            let landed = XCTNSPredicateExpectation(
                predicate: NSPredicate { _, _ in
                    (try? String(contentsOf: file, encoding: .utf8)).map(matches) ?? false
                }, object: nil)
            return XCTWaiter.wait(for: [landed], timeout: 5) == .completed
        }
        func saved(_ text: String) -> Bool { saved { $0 == text } }

        // Keyboard down: hold `alpha` past the lift, then carry it below `delta` (the drop
        // line there is the note's end). The lift starts no editing.
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        line(0).press(
            forDuration: 0.8, thenDragTo: line(3).withOffset(CGVector(dx: 0, dy: 10)),
            withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(saved("bravo\ncharlie\ndelta\nalpha"), "the held line lands at the drop line")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "a lift does not raise the keyboard")

        line(1, x: 40).doubleTap()
        editor.typeText("Z")
        XCTAssertTrue(saved("bravo\nZ\ndelta\nalpha"), "a double-tap selects the word it hits")

        // Keyboard up: a hold is the platform's. Its loupe carries the caret to where the
        // finger lets go, at a line's start, and nothing lifts: typing lands there and no line
        // moves (a lift would have carried the line, or left the caret after `Z`).
        line(0).press(
            forDuration: 0.8, thenDragTo: line(2, x: 2), withVelocity: .slow,
            thenHoldForDuration: 0.3)
        editor.typeText("Y")
        XCTAssertTrue(
            saved { text in
                text.replacingOccurrences(of: "Y", with: "") == "bravo\nZ\ndelta\nalpha"
                    && !text.contains("ZY")
            }, "a long-press while editing places the caret and moves no line")
    }
}
