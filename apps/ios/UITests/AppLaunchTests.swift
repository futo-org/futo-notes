import XCTest

final class AppLaunchTests: XCTestCase {
    @MainActor
    func testShellRendersWithoutWaitingForVaultBootstrap() {
        let app = makeIsolatedApplication()
        app.launch()

        XCTAssertTrue(app.navigationBars["Notes"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testNativeFindBarOpensAboveKeyboardInAnIsolatedNote() {
        let app = makeIsolatedApplication()
        app.launch()

        let create = app.buttons["New note or folder"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        create.tap()
        app.buttons["New Note"].tap()

        let more = app.buttons["More"]
        XCTAssertTrue(more.waitForExistence(timeout: 5))
        more.tap()
        app.buttons["Find in note"].tap()

        let query = app.textFields["Find in note"]
        XCTAssertTrue(query.waitForExistence(timeout: 5))
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(query.frame.maxY, keyboard.frame.minY)
        XCTAssertLessThan(keyboard.frame.minY - query.frame.maxY, 24)
        XCTAssertTrue(app.staticTexts["0"].exists)
        query.typeText("needle")
        XCTAssertTrue(app.staticTexts["0"].exists)
    }
}
