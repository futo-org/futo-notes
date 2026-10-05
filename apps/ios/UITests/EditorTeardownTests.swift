import XCTest

/// Leaving an open note destroys its `EditorWebView`, and `dismantleUIView`
/// used to write SwiftUI `@State` from inside that teardown
/// (`coordinator.onAttachmentChange?(nil)` → `editorAttachment = nil`).
/// AttributeGraph is invalidating the subgraph that owns that state at that
/// moment, so the write trips Swift's exclusivity check: "Fatal access
/// conflict detected" → `abort()`. Every exit from a note aborted the app
/// (v1.7.2 verify-specs pass; four identical crash reports whose stack is
/// `State.wrappedValue.setter` ← `EditorWebView.dismantleUIView`). Introduced
/// with the native find-in-note bar.
///
/// This has to be a launch-level test: the closure is harmless in isolation
/// and fatal only because of WHEN it runs, so any unit test that called it
/// would pass.
///
/// The note must be **reopened**, not freshly created. On a reopen the shared
/// `EditorHost` is already `ready`, so `attach` pushes content and reports the
/// new attachment token synchronously inside
/// `makeUIView` — which is what leaves that `@State` location mid-update when
/// the pop tears the view down. Creating a note seconds after launch races the
/// host's pre-warm and did NOT reproduce.
///
/// Only the plain Back exit is asserted here. Leaving with the find bar open,
/// just closed, or mid-IME shifts the update pass enough that the abort did
/// not fire pre-fix, so those variants would be green either way — they were
/// verified by hand on the simulator instead of parked here as tests that
/// cannot fail.
final class EditorTeardownTests: XCTestCase {
    @MainActor
    func testLeavingAReopenedNoteWithTheBackButtonDoesNotAbort() {
        let app = makeIsolatedApplication()
        app.launch()

        reopenASeededNote(in: app)
        tapBack(in: app)

        assertStillOnTheNotesList(app)
    }
}

/// Leave a note behind in the isolated vault and open it again from the list.
///
/// Quick capture is one tap: the compose nav button creates the note and opens
/// straight into its body (see AppLaunchTests). Typing a title is what makes it
/// survive the exit — an untouched quick capture is discarded on Back
/// (list.md), which would leave nothing to reopen.
@MainActor
private func reopenASeededNote(in app: XCUIApplication) {
    let create = app.buttons["nav-create"]
    XCTAssertTrue(create.waitForExistence(timeout: 5))
    create.tap()
    // The system back button's presence is also the signal that the editor
    // screen is up.
    XCTAssertTrue(backButton(in: app).waitForExistence(timeout: 5))

    let titleField = app.textFields.firstMatch
    XCTAssertTrue(titleField.waitForExistence(timeout: 5))
    titleField.tap()
    titleField.typeText(seededNoteTitle)

    tapBack(in: app)
    XCTAssertTrue(
        app.navigationBars["Notes"].waitForExistence(timeout: 10),
        "seeding the note never returned to the list"
    )

    // Leaving commits the typed title, but match "Untitled" too so this test
    // stays about teardown rather than the rename.
    let row = app.buttons
        .matching(
            NSPredicate(
                format: "label CONTAINS %@ OR label BEGINSWITH 'Untitled'",
                seededNoteTitle
            )
        )
        .firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5), "the seeded note is not in the list")
    row.tap()
    XCTAssertTrue(backButton(in: app).waitForExistence(timeout: 5), "the note did not reopen")
}

private let seededNoteTitle = "QA Teardown"

/// The editor shows the SYSTEM back button, labelled with the previous
/// screen's title rather than "Back"; UIKit identifies it as "BackButton".
@MainActor
private func backButton(in app: XCUIApplication) -> XCUIElement {
    app.navigationBars.buttons["BackButton"]
}

@MainActor
private func tapBack(in app: XCUIApplication) {
    let back = backButton(in: app)
    XCTAssertTrue(back.waitForExistence(timeout: 5))
    back.tap()
}

/// The app is alive AND back on the list. A crash fails the first assertion
/// (the process is gone, so nothing resolves) and is named by the second.
@MainActor
private func assertStillOnTheNotesList(_ app: XCUIApplication) {
    XCTAssertTrue(
        app.navigationBars["Notes"].waitForExistence(timeout: 10),
        "leaving the note never landed back on the notes list"
    )
    XCTAssertEqual(
        app.state,
        .runningForeground,
        "the app aborted while tearing down the editor"
    )
}
