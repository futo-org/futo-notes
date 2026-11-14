import XCTest

/// Find on the text-first editor, driven with real touches: the overflow menu opens the bar above
/// the keyboard, typing a query counts matches, Next steps, Done closes. Screenshots go to
/// `TF_DIR` for a human look. Run: `just test-ios-native-ui TextFirstFindUITests`.
final class TextFirstFindUITests: XCTestCase {
    private static let note = """
        Find demo

        The cat sat on the **cat** mat. Another cat here.

        | animal | note |
        |---|---|
        | cat | a cat |
        | dog | no |

        Last cat line.
        """

    @MainActor
    func testTheBarOpensAboveTheKeyboardCountsAndSteps() throws {
        let base = ProcessInfo.processInfo.environment["TF_DIR"] ?? NSTemporaryDirectory() + "tf-ui"
        let root = URL(fileURLWithPath: base).appendingPathComponent(UUID().uuidString)
        let vault = root.appendingPathComponent("vault")
        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
        try Self.note.write(
            to: vault.appendingPathComponent("findme.md"), atomically: true, encoding: .utf8)
        let app = makeIsolatedApplication(textFirstEditor: true)
        app.launchEnvironment["FUTO_NOTES_DATA_DIR"] = vault.path
        app.launchArguments += ["-AppleLanguages", "(en)"]
        app.launch()
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "findme"))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        let editor = app.textViews["text-first-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 15))

        func shot(_ name: String) {
            try? app.screenshot().pngRepresentation.write(
                to: root.appendingPathComponent("\(name).png"))
        }
        app.buttons["More"].firstMatch.tap()
        app.buttons["Find in note"].firstMatch.tap()
        let field = app.textFields["Find in note"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("cat")
        let count = app.staticTexts["1 of 6"]
        XCTAssertTrue(count.waitForExistence(timeout: 5), "count after typing the query")
        shot("1-typed")
        app.buttons["Next match"].tap()
        app.buttons["Next match"].tap()
        XCTAssertTrue(app.staticTexts["2 of 6"].waitForExistence(timeout: 5))
        shot("2-stepped")
        app.buttons["Next match"].tap()
        app.buttons["Next match"].tap()
        app.buttons["Next match"].tap()
        XCTAssertTrue(app.staticTexts["5 of 6"].waitForExistence(timeout: 5))
        shot("3-in-table")
        app.buttons["Close find"].tap()
        XCTAssertFalse(field.exists)
        shot("4-closed")
        print("TF_SHOTS \(root.path)")
    }
}
