import UIKit
import XCTest

/// The long-press block drag with real touches (#441): UIKit's own recognizers on the note
/// must neither hold the lift back nor take a double-tap's word selection from it.
final class TextFirstBlockDragUITests: XCTestCase {
    @MainActor
    func testAHoldLiftsALineAndReleasingDropsItWhileADoubleTapStillSelectsAWord() throws {
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
        func saved(_ text: String) -> Bool {
            let landed = XCTNSPredicateExpectation(
                predicate: NSPredicate { _, _ in
                    (try? String(contentsOf: file, encoding: .utf8)) == text
                }, object: nil)
            return XCTWaiter.wait(for: [landed], timeout: 5) == .completed
        }

        line(2, x: 40).doubleTap()
        editor.typeText("Z")
        XCTAssertTrue(saved("alpha\nbravo\nZ\ndelta"), "a double-tap selects the word it hits")

        // Hold `alpha` past the lift, then carry it below `delta`: the drop line there is the
        // note's end.
        line(0).press(
            forDuration: 0.8, thenDragTo: line(3).withOffset(CGVector(dx: 0, dy: 10)),
            withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(saved("bravo\nZ\ndelta\nalpha"), "the held line lands at the drop line")
    }
}
