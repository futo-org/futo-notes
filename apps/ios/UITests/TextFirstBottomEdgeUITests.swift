import XCTest

/// The text-first editor runs to the physical bottom edge (no strip under the home indicator),
/// while the find bar, with the keyboard down, still sits above the indicator.
/// Run: `just test-ios-native-ui TextFirstBottomEdgeUITests`.
final class TextFirstBottomEdgeUITests: XCTestCase {
    @MainActor
    func testEditorReachesTheBottomEdgeAndTheFindBarStaysAboveTheHomeIndicator() throws {
        let vault = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("tf-bottom-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
        let body = (1...80).map { "Line \($0) of a note long enough to scroll" }
            .joined(separator: "\n\n")
        try body.write(
            to: vault.appendingPathComponent("edge.md"), atomically: true, encoding: .utf8)
        let app = makeIsolatedApplication(textFirstEditor: true)
        app.launchEnvironment["FUTO_NOTES_DATA_DIR"] = vault.path
        app.launchArguments += ["-AppleLanguages", "(en)"]
        app.launch()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "edge")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        let editor = app.textViews["text-first-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        let window = app.windows.firstMatch.frame

        XCTAssertEqual(
            editor.frame.maxY, window.maxY, accuracy: 0.5,
            "the editor ends at the window's bottom edge, not at the safe area")

        // Find open, keyboard down: the bar clears the home indicator.
        app.buttons["More"].firstMatch.tap()
        app.buttons["Find in note"].firstMatch.tap()
        XCTAssertTrue(app.textFields["Find in note"].waitForExistence(timeout: 5))
        editor.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        let dismiss = app.buttons["Dismiss keyboard"].firstMatch
        XCTAssertTrue(dismiss.waitForExistence(timeout: 5))
        dismiss.tap()
        let close = app.buttons["Close find"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        // The test process cannot read the window's safe-area inset. A device with a home indicator
        // (tall screens: every iPhone from the X on, and the iPads) has at least 20 pt of it at the
        // bottom (34 pt on an iPhone); one with a home button has none, and the bar's own padding
        // alone puts it above the edge.
        let safeAreaBottom: CGFloat = window.height >= 800 ? 20 : 0
        XCTAssertLessThanOrEqual(
            close.frame.maxY, window.maxY - safeAreaBottom,
            "the find bar sits above the home indicator when the keyboard is down")
    }
}
