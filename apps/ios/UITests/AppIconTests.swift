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
        let choice = app.buttons["app-icon-futo"]
        XCTAssertTrue(choice.waitForExistence(timeout: 10))
        choice.tap()
        // Apple's own notification is kept; the picker must survive it.
        let alert = app.alerts.firstMatch
        if alert.waitForExistence(timeout: 5) { alert.buttons.firstMatch.tap() }
        XCTAssertTrue(app.navigationBars["App icon"].exists)
        XCTAssertTrue(choice.isSelected)
        app.navigationBars["App icon"].buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].exists)
        row.tap()
        let primary = app.buttons["app-icon-light-standard"]
        XCTAssertTrue(primary.waitForExistence(timeout: 10))
        primary.tap()
        if alert.waitForExistence(timeout: 5) { alert.buttons.firstMatch.tap() }
        XCTAssertTrue(primary.isSelected)
    }
}
