import Darwin
import XCTest

/// A leave that cannot save keeps the draft, driven with real touches: the vault directory loses
/// its write bit (this runner and the simulator app are processes of the same Mac user, so the
/// runner can take it away and give it back), the user types, goes Back, opens the note again and
/// finds the draft with a persistent save error to Retry or Discard.
/// Run: `just test-ios-native-ui TextFirstLeaveUITests`.
final class TextFirstLeaveUITests: XCTestCase {
    private var root: URL!
    private var vault: URL { root.appendingPathComponent("vault") }
    private var app: XCUIApplication!

    override func setUp() async throws {
        continueAfterFailure = false
        let base = ProcessInfo.processInfo.environment["TF_DIR"] ?? NSTemporaryDirectory() + "tf-ui"
        root = URL(fileURLWithPath: base).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
        try "Leave demo\n".write(
            to: vault.appendingPathComponent("leaveme.md"), atomically: true, encoding: .utf8)
    }

    override func tearDown() async throws {
        chmod(vault.path, 0o755)
    }

    private func disk() -> String {
        (try? String(contentsOf: vault.appendingPathComponent("leaveme.md"), encoding: .utf8)) ?? ""
    }

    /// Open the note, type, make the vault unwritable and go Back: the leave cannot save.
    @MainActor
    private func leaveWithTheDiskFailing() throws {
        app = makeIsolatedApplication()
        app.launchEnvironment["FUTO_NOTES_DATA_DIR"] = vault.path
        app.launchArguments += ["-AppleLanguages", "(en)"]
        app.launch()
        openNote()
        let editor = app.textViews["text-first-editor"]
        editor.tap()
        editor.typeText(" typed")
        XCTAssertEqual(chmod(vault.path, 0o555), 0)
        systemBackButton(in: app).tap()
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "leaveme")).firstMatch
                .waitForExistence(timeout: 10), "back on the note list")
        XCTAssertFalse(disk().contains("typed"), "the write was refused")
    }

    @MainActor
    private func openNote() {
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "leaveme"))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15), "note not listed")
        row.tap()
        XCTAssertTrue(
            app.textViews["text-first-editor"].waitForExistence(timeout: 15),
            "editor did not appear")
    }

    @MainActor
    func testTheDraftComesBackWithARetryThatSavesIt() throws {
        try leaveWithTheDiskFailing()
        // Well past the old limit of ten attempts (2 s apart): the leave never gave the draft up.
        Thread.sleep(forTimeInterval: 24)
        openNote()
        XCTAssertTrue(
            app.staticTexts["text-first-save-error"].waitForExistence(timeout: 10),
            "the save error is shown on the note")
        XCTAssertTrue((app.textViews["text-first-editor"].value as? String ?? "").contains("typed"))
        XCTAssertEqual(chmod(vault.path, 0o755), 0)
        app.buttons["text-first-save-retry"].tap()
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: app.staticTexts["text-first-save-error"])
        waitForExpectations(timeout: 10)
        XCTAssertTrue(disk().contains("typed"), "the retry wrote the draft")
    }

    @MainActor
    func testDiscardAsksThenDropsTheDraftAndTheNoteOpensAgain() throws {
        try leaveWithTheDiskFailing()
        openNote()
        XCTAssertTrue(app.buttons["text-first-save-discard"].waitForExistence(timeout: 10))
        app.buttons["text-first-save-discard"].tap()
        // A confirmation first: cancelling keeps the draft.
        let ask = app.alerts.firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        ask.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["text-first-save-discard"].exists)
        app.buttons["text-first-save-discard"].tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 5))
        app.alerts.firstMatch.buttons["Discard edits"].tap()
        // The disk recovers only now: nothing may write the discarded draft.
        XCTAssertEqual(chmod(vault.path, 0o755), 0)
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "leaveme")).firstMatch
                .waitForExistence(timeout: 10), "back on the note list")
        XCTAssertFalse(disk().contains("typed"), "discarded edits were not written")
        openNote()
        XCTAssertFalse(
            (app.textViews["text-first-editor"].value as? String ?? "").contains("typed"))
        XCTAssertFalse(app.staticTexts["text-first-save-error"].exists)
    }
}
