import UIKit
import XCTest

/// Real touches on a list item's marker unit: a tap puts the caret on the nearer side of a
/// bullet, a hold while editing selects the marker alone with the edit menu, and a held
/// checkbox is selected, not ticked, while a tapped one is ticked.
final class TextFirstListMarkerUITests: XCTestCase {
    /// The marker column's middle and a point a few points inside each half, in the editor's
    /// coordinates (inset 20, a bullet's or box's column 30 wide), on display line `line`.
    private func point(_ editor: XCUIElement, x: CGFloat, line: Int) -> XCUICoordinate {
        let y = 4 + CGFloat(line) * (UIFont.systemFont(ofSize: 17).lineHeight + 4) + 10
        return editor.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    @MainActor
    private func open(_ source: String, named name: String) throws -> (
        XCUIApplication, XCUIElement, URL
    ) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("text-first-markers-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("\(name).md")
        try source.write(to: file, atomically: true, encoding: .utf8)
        let app = makeIsolatedApplication()
        app.launchEnvironment["FUTO_NOTES_DATA_DIR"] = root.path
        app.launchArguments += ["-AppleLanguages", "(en)"]
        app.launch()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        let editor = app.textViews["text-first-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        return (app, editor, file)
    }

    /// Long enough that two taps are not one double tap.
    private func pause() {
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "pause")], timeout: 1)
    }

    private func saved(_ file: URL, _ check: @escaping (String) -> Bool) -> Bool {
        let done = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                (try? String(contentsOf: file, encoding: .utf8)).map(check) == true
            }, object: nil)
        return XCTWaiter.wait(for: [done], timeout: 5) == .completed
    }

    @MainActor
    func testATapOnABulletsHalvesPutsTheCaretOnThatSide() throws {
        let (_, editor, file) = try open("- one\n- two\n", named: "halves")
        point(editor, x: 120, line: 0).tap()  // the keyboard comes up
        point(editor, x: 44, line: 0).tap()  // the bullet's right half
        editor.typeText("R")
        XCTAssertTrue(saved(file) { $0 == "- Rone\n- two\n" }, "right half: the text's start")
        point(editor, x: 24, line: 1).tap()  // the bullet's left half
        editor.typeText("L")
        XCTAssertTrue(
            saved(file) { $0 == "- Rone\nL- two\n" }, "left half: before the marker")
    }

    /// The keyboard capitalises at an item's text start as at a line's start, when its own
    /// Auto-Capitalization setting does (on in the simulator), and not in the middle of a line.
    @MainActor
    func testTheKeyboardShiftsAtAnItemsTextStart() throws {
        let (app, editor, _) = try open("- one\n- two\n", named: "shift")
        point(editor, x: 120, line: 0).tap()  // the keyboard comes up, the caret after "one"
        XCTAssertTrue(app.keys["q"].waitForExistence(timeout: 5), "mid-line: no shift")
        pause()
        point(editor, x: 44, line: 1).tap()  // the bullet's right half: the text's start
        XCTAssertTrue(app.keys["Q"].waitForExistence(timeout: 5), "an item's text start: shift")
    }

    @MainActor
    func testAHoldSelectsTheMarkerAndAHeldCheckboxIsNotTicked() throws {
        let (app, editor, file) = try open("- one\n- [ ] two\n- [ ] three\n", named: "holds")
        point(editor, x: 120, line: 0).tap()  // editing: a hold is the marker's
        point(editor, x: 35, line: 0).press(forDuration: 1.2)
        XCTAssertTrue(app.menuItems["Cut"].waitForExistence(timeout: 3), "the edit menu")
        app.menuItems["Copy"].tap()
        // The marker alone was selected: typing over it takes it off.
        editor.typeText("x")
        XCTAssertTrue(saved(file) { $0.hasPrefix("xone\n") }, "the hold selected the marker")
        // What Copy gives for that selection (`- `) is TextFirstListMarkerTests'; the test runner
        // may not read the pasteboard.
        // A held box is selected, not ticked: typing over it takes it off.
        point(editor, x: 35, line: 1).press(forDuration: 1.2)
        XCTAssertTrue(app.menuItems["Copy"].waitForExistence(timeout: 3), "the box is selected")
        editor.typeText("y")
        XCTAssertTrue(
            saved(file) { $0 == "xone\nytwo\n- [ ] three\n" }, "a hold ticks nothing")
        pause()
        point(editor, x: 35, line: 2).tap()
        XCTAssertTrue(saved(file) { $0.contains("- [x] three") }, "a tap ticks it")
    }
}
