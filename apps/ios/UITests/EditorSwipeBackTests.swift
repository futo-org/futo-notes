import XCTest

/// The editor keeps the system back button, so Back and the edge swipe are the
/// native interactive pop, and the editor commits AFTER it has left
/// (`NoteEditorView.finishLeave`). By then the popped editor's view is detached
/// from the one shared WebView, and on a wikilink pop the note revealed
/// underneath re-attaches and pushes ITS document. A capture that trusted the
/// WebView at that point wrote the parent's body over the linked note on every
/// round trip, with no edit at all (reproduced on the simulator, 2026-09-23).
///
/// Launch-level because the bug is WHEN the capture runs relative to SwiftUI
/// re-attaching the parent, which no unit test can stage.
final class EditorSwipeBackTests: XCTestCase {
    @MainActor
    func testReturningFromAWikilinkLeavesTheLinkedNoteIntact() {
        let app = makeIsolatedApplication()
        app.launch()

        createNote(in: app, title: "Child", body: "child body")
        createNote(in: app, title: "Parent", body: "parent body [[Child]]")

        openRow(in: app, title: "Parent")
        let link = app.webViews.staticTexts["Child"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 10), "the wikilink did not render")
        link.tap()
        XCTAssertTrue(
            app.webViews.staticTexts["child body"].waitForExistence(timeout: 10),
            "the wikilink did not open the linked note"
        )

        tapBack(in: app)
        XCTAssertTrue(
            app.webViews.staticTexts["parent body "].waitForExistence(timeout: 10)
                || app.webViews.staticTexts.matching(
                    NSPredicate(format: "label BEGINSWITH 'parent body'")
                ).firstMatch.waitForExistence(timeout: 5),
            "Back did not return to the parent note"
        )
        tapBack(in: app)
        XCTAssertTrue(app.navigationBars["Notes"].waitForExistence(timeout: 10))

        let child = row(in: app, title: "Child")
        XCTAssertTrue(child.waitForExistence(timeout: 5))
        XCTAssertFalse(
            child.label.contains("parent body"),
            "the linked note was overwritten with the parent's body: \(child.label)"
        )
        XCTAssertTrue(child.label.contains("child body"), "row: \(child.label)")
    }
}

/// Quick capture opens with the body focused; the typed title commits on leave.
@MainActor
private func createNote(in app: XCUIApplication, title: String, body: String) {
    let create = app.buttons["nav-create"]
    XCTAssertTrue(create.waitForExistence(timeout: 5))
    create.tap()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 5))
    app.typeText(body)
    let titleField = app.textFields.firstMatch
    XCTAssertTrue(titleField.waitForExistence(timeout: 5))
    titleField.tap()
    titleField.typeText(title)
    tapBack(in: app)
    XCTAssertTrue(row(in: app, title: title).waitForExistence(timeout: 10), "\(title) was not saved")
}

@MainActor
private func row(in app: XCUIApplication, title: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
}

@MainActor
private func openRow(in app: XCUIApplication, title: String) {
    let target = row(in: app, title: title)
    XCTAssertTrue(target.waitForExistence(timeout: 5))
    target.tap()
    XCTAssertTrue(app.navigationBars.buttons["BackButton"].waitForExistence(timeout: 5))
}

@MainActor
private func tapBack(in app: XCUIApplication) {
    let back = app.navigationBars.buttons["BackButton"]
    XCTAssertTrue(back.waitForExistence(timeout: 5))
    back.tap()
}
