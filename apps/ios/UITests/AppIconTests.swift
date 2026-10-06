import XCTest

final class AppIconTests: XCTestCase {
    @MainActor
    func testSelectingAnIconKeepsPickerOpenAndDoneReturnsToSettings() {
        let app = makeIsolatedApplication()
        app.launch()
        let settings = app.buttons["nav-settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 20))
        settings.tap()
        let row = app.buttons["settings-app-icon"]
        for _ in 0..<8 {
            if row.exists && row.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(row.isHittable)
        row.tap()
        XCTAssertTrue(app.navigationBars["App icon"].waitForExistence(timeout: 10))

        // One switch to any choice other than the current one.
        let choice = ["futo", "website"]
            .map { app.buttons["app-icon-\($0)"] }
            .first { !$0.isSelected }!
        XCTAssertTrue(choice.waitForExistence(timeout: 10))
        choice.tap()
        // Apple's own notification is kept; the picker must survive it.
        dismissIconNotification(app)
        waitForSelection(choice, in: app)
        XCTAssertTrue(choice.isSelected, "\(choice.identifier) should be the active icon")

        XCTAssertTrue(app.navigationBars["App icon"].exists)
        app.navigationBars["App icon"].buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))

        restoreDefaultIcon(app, row: row)
    }

    /// Best-effort, never asserts: leaves the installation on the default icon so
    /// later runs on a reused simulator start from a known state.
    @MainActor
    private func restoreDefaultIcon(_ app: XCUIApplication, row: XCUIElement) {
        guard row.waitForExistence(timeout: 5) else { return }
        row.tap()
        let primary = app.buttons["app-icon-light-standard"]
        guard primary.waitForExistence(timeout: 10), !primary.isSelected else { return }
        primary.tap()
        dismissIconNotification(app)
    }

    @MainActor
    private func waitForSelection(_ element: XCUIElement, in app: XCUIApplication) {
        let selected = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in element.isSelected },
            object: app,
        )
        XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 10), .completed)
    }

    @MainActor
    private func dismissIconNotification(_ app: XCUIApplication) {
        let alert = app.alerts.firstMatch
        if alert.waitForExistence(timeout: 2) {
            alert.buttons.firstMatch.tap()
            return
        }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let systemAlert = springboard.alerts.firstMatch
        if systemAlert.waitForExistence(timeout: 3) { systemAlert.buttons.firstMatch.tap() }
    }

}
