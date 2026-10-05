import XCTest

/// Undo in the inline title field after it refused or cleaned an edit.
///
/// Crash 1747 (1.7.2): the field stripped a forbidden character by rewriting
/// its own `text`, which left UIKit's undo stack recording a range past the
/// new end, so the next undo threw NSRangeException in NSMutableRLEArray.
///
/// This has to be a launch-level test. Only real keyboard input and a real
/// paste go through UIKit's delegate-consulting paths and its paste bookkeeping.
/// A unit test's `insertText` skips both, and it passed a version of the fix
/// whose paste still broke the next undo.
final class TitleFieldUndoTests: XCTestCase {
    @MainActor
    func testUndoAfterATypedForbiddenCharacterDoesNotCrash() {
        let (app, title) = openNewNoteTitle()
        title.typeText("abc?")
        XCTAssertEqual(title.value as? String, "abc")

        undo(3, in: title)
        XCTAssertEqual(app.state, .runningForeground, "undo crashed the app")
        XCTAssertNotEqual(title.value as? String, "abc", "undo did nothing")
    }

    @MainActor
    func testAPasteWithForbiddenCharactersIsCleanedAndUndoable() {
        let (app, title) = openNewNoteTitle()
        title.typeText("Plan ")
        UIPasteboard.general.string = "x/y:z"
        // The edit menu's Paste, the everyday path: a keyboard ⌘V from another
        // app's pasteboard can be refused by the "Paste from Other Apps" setting.
        title.press(forDuration: 1.0)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "the edit menu has no Paste")
        paste.tap()
        let cleaned = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "Plan xyz"), object: title)
        XCTAssertEqual(
            XCTWaiter.wait(for: [cleaned], timeout: 5), .completed,
            "the paste did not arrive cleaned")
        // The caret must sit after the pasted text, not where the paste began.
        title.typeText("q")
        XCTAssertEqual(title.value as? String, "Plan xyzq")

        undo(3, in: title)
        XCTAssertEqual(app.state, .runningForeground, "undo crashed the app")
        XCTAssertNotEqual(title.value as? String, "Plan xyzq", "undo did nothing")
    }
}

/// Quick capture opens a new note; tapping its placeholder title selects it
/// whole, so the first keystroke replaces "Untitled".
@MainActor
private func openNewNoteTitle() -> (XCUIApplication, XCUIElement) {
    let app = makeIsolatedApplication()
    app.launch()
    let create = app.buttons["nav-create"].firstMatch
    XCTAssertTrue(create.waitForExistence(timeout: 5))
    create.tap()
    let title = app.textFields.firstMatch
    XCTAssertTrue(title.waitForExistence(timeout: 5))
    title.tap()
    return (app, title)
}

@MainActor
private func undo(_ times: Int, in field: XCUIElement) {
    for _ in 0..<times { field.typeKey("z", modifierFlags: .command) }
}
