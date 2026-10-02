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

        let primary = app.buttons["app-icon-light-standard"]
        XCTAssertTrue(primary.waitForExistence(timeout: 10))
        if !primary.isSelected {
            primary.tap()
            dismissIconNotification(app)
            waitForSelection(primary, in: app)
        }
        primary.tap()
        waitForSelection(primary, in: app)

        for iconID in ["light-reversed", "dark-standard", "dark-reversed", "futo", "website"] {
            let choice = app.buttons["app-icon-\(iconID)"]
            XCTAssertTrue(choice.waitForExistence(timeout: 10))
            choice.tap()
            // Apple's own notification is kept; the picker must survive it.
            dismissIconNotification(app)
            waitForSelection(choice, in: app)
            XCTAssertTrue(choice.isSelected, "\(iconID) should be the active icon")
        }
        XCTAssertTrue(app.navigationBars["App icon"].exists)
        app.navigationBars["App icon"].buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        XCTAssertTrue(row.label.contains("Scanlines"))
        row.tap()
        XCTAssertTrue(app.navigationBars["App icon"].waitForExistence(timeout: 10))
        primary.tap()
        dismissIconNotification(app)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "icon-reset-result"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        waitForSelection(primary, in: app)
        XCTAssertTrue(primary.isSelected, app.debugDescription)
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
