import XCTest

final class AppIconTests: XCTestCase {
    private var deepLink: URL { URL(string: LicenseFixture.deepLink)! }

    @MainActor
    func testSelectingAnIconKeepsPickerOpenAndDoneReturnsToSettings() {
        // Choosing most icons comes with a license, and the license is the one
        // cross-run state a simulator keeps: activate the staging pair first.
        // The landing opens the picker over Settings by itself.
        let app = makeIsolatedApplication()
        app.launch()
        XCTAssertTrue(app.buttons["nav-settings"].waitForExistence(timeout: 20))
        XCUIDevice.shared.system.open(deepLink)
        XCTAssertTrue(app.navigationBars["App icon"].waitForExistence(timeout: 15))
        let row = app.buttons["settings-app-icon"]

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
        removeLicense(app)
    }

    /// Unlicensed, a tile other than the current one is an ask, never an icon
    /// change: the sheet's shape follows the storefront (link-out in the US,
    /// key-only elsewhere) and "Not now" returns to the grid. Foregrounding the
    /// app (the return from Safari after Buy) must leave the sheet up.
    @MainActor
    func testUnlicensedTileOpensTheAskInsteadOfChangingTheIcon() {
        for (country, linkOut) in [("USA", true), ("FRA", false)] {
            let app = makeIsolatedApplication()
            openUnlicensedPicker(app, storefront: country)

            XCTAssertTrue(app.staticTexts["app-icon-footnote"].waitForExistence(timeout: 5))
            // A reused simulator may keep any icon; the current one, Standard
            // and Reversed are the tiles without a coin.
            let current = Self.tiles(app).first { $0.isSelected }!
            let tile = Self.licenseTiles(app).first { !$0.isSelected }!
            XCTAssertFalse(current.label.contains("included with a license"))
            XCTAssertEqual(app.buttons["app-icon-light-standard"].label, "Standard")
            XCTAssertEqual(app.buttons["app-icon-light-reversed"].label, "Reversed")
            XCTAssertTrue(tile.label.hasSuffix(", included with a license"), tile.label)
            attach(app, named: "picker-unlicensed-\(country)")
            tile.tap()

            let title = app.staticTexts["app-icon-ask-title"]
            XCTAssertTrue(title.waitForExistence(timeout: 5))
            XCTAssertEqual(title.label, "Included with a license")
            XCTAssertEqual(app.buttons["app-icon-ask-buy"].exists, linkOut)
            XCTAssertTrue(app.buttons["app-icon-ask-already-paid"].exists)

            XCUIDevice.shared.press(.home)
            app.activate()
            XCTAssertTrue(
                title.waitForExistence(timeout: 10), "foregrounding dropped the ask sheet")
            attach(app, named: "ask-sheet-\(country)")

            app.buttons["app-icon-ask-not-now"].tap()
            XCTAssertTrue(tile.waitForExistence(timeout: 5))
            XCTAssertFalse(title.exists)
            XCTAssertTrue(current.isSelected, "the ask must not have changed the icon")
            app.terminate()
        }
    }

    /// "I already paid" leaves the picker for the License card's key field.
    @MainActor
    func testAlreadyPaidOpensTheKeyFieldOnTheCard() {
        let app = makeIsolatedApplication()
        openUnlicensedPicker(app, storefront: "USA")
        Self.licenseTiles(app).first { !$0.isSelected }!.tap()
        let paid = app.buttons["app-icon-ask-already-paid"]
        XCTAssertTrue(paid.waitForExistence(timeout: 5))
        paid.tap()

        XCTAssertTrue(app.textFields["license-key-field"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.navigationBars["App icon"].exists)
    }

    /// Launches unlicensed in `storefront`, and opens the App icon picker.
    @MainActor
    private func openUnlicensedPicker(_ app: XCUIApplication, storefront: String) {
        app.launchArguments += ["-FUTOLicenseStorefront", storefront]
        app.launch()
        openSettings(app)
        removeLicense(app)
        let row = scrollToAppIconRow(app)
        XCTAssertTrue(app.staticTexts["More with a license"].exists, "the App icon row lost its hint")
        attach(app, named: "settings-row-hint-\(storefront)")
        row.tap()
        XCTAssertTrue(app.navigationBars["App icon"].waitForExistence(timeout: 10))
    }

    private static let iconIds = [
        "light-standard", "light-reversed", "dark-standard", "dark-reversed", "futo", "website",
    ]

    @MainActor
    private static func tiles(_ app: XCUIApplication) -> [XCUIElement] {
        iconIds.map { app.buttons["app-icon-\($0)"] }
    }

    /// The tiles a license includes: all but Standard and Reversed.
    @MainActor
    private static func licenseTiles(_ app: XCUIApplication) -> [XCUIElement] {
        iconIds.dropFirst(2).map { app.buttons["app-icon-\($0)"] }
    }

    /// Activating by deep link lands on the picker over Settings with the
    /// one-time header; the licensed grid keeps the coin on all but Standard and Reversed
    /// and drops the footnote, and reopening shows the plain grid.
    @MainActor
    func testActivationLandsOnThePickerWithAOneTimeHeader() {
        let app = makeIsolatedApplication()
        // The toast lives ~3.5 s from the activation, and `system.open` and the sheet
        // animations block this process for most of that. Hold it open so the test
        // asks what it means to: is the toast drawn over the picker?
        app.launchArguments += [
            "-FUTOLicenseStorefront", "USA", "-FUTOTransientSeconds", "60",
        ]
        app.launch()
        openSettings(app)
        removeLicense(app)
        app.navigationBars["Settings"].buttons["Done"].tap()
        XCTAssertTrue(app.buttons["nav-settings"].waitForExistence(timeout: 10))

        XCUIDevice.shared.system.open(deepLink)

        XCTAssertTrue(app.navigationBars["App icon"].waitForExistence(timeout: 15))
        // The toast is drawn inside the picker, not under it. A banner on the list
        // beneath the sheets is still in the accessibility tree, so existence alone
        // proves nothing: one copy of the toast must be reachable on top.
        let toast = app.staticTexts.matching(identifier: "License activated")
        XCTAssertTrue(toast.firstMatch.waitForExistence(timeout: 3), "the toast never showed")
        XCTAssertTrue(
            toast.allElementsBoundByIndex.contains { $0.isHittable },
            "the toast is hidden by the picker")
        XCTAssertTrue(
            app.staticTexts["Thank you for purchasing FUTO Notes."].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts["Your license includes every app icon."].exists)
        XCTAssertFalse(app.staticTexts["app-icon-footnote"].exists)
        XCTAssertEqual(app.buttons["app-icon-light-standard"].label, "Standard")
        XCTAssertEqual(app.buttons["app-icon-light-reversed"].label, "Reversed")
        XCTAssertEqual(app.buttons["app-icon-futo"].label, "FUTO, included with a license")
        attach(app, named: "landing")

        app.navigationBars["App icon"].buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        XCTAssertFalse(
            app.staticTexts["More with a license"].exists, "the hint stayed after the license arrived")
        scrollToAppIconRow(app).tap()
        XCTAssertTrue(app.navigationBars["App icon"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Thank you for purchasing FUTO Notes."].exists)
        XCTAssertEqual(app.buttons["app-icon-futo"].label, "FUTO, included with a license")
        attach(app, named: "licensed-grid")

        app.navigationBars["App icon"].buttons["Done"].tap()
        removeLicense(app)
    }

    @MainActor
    private func openSettings(_ app: XCUIApplication) {
        let settings = app.buttons["nav-settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 20))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    }

    /// A pooled simulator can arrive licensed from somebody else's session, and
    /// leaves licensed if a test dies: Remove is the supported way back.
    @MainActor
    private func removeLicense(_ app: XCUIApplication) {
        let remove = app.buttons["license-remove"]
        for _ in 0..<8 where remove.exists && !remove.isHittable { app.swipeDown() }
        if remove.waitForExistence(timeout: 5) { remove.tap() }
    }

    @MainActor @discardableResult
    private func scrollToAppIconRow(_ app: XCUIApplication) -> XCUIElement {
        let row = app.buttons["settings-app-icon"]
        for _ in 0..<8 {
            if row.exists && row.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(row.isHittable)
        return row
    }

    @MainActor
    private func attach(_ app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Best-effort, never asserts: leaves the installation on the default icon so
    /// later runs on a reused simulator start from a known state.
    @MainActor
    private func restoreDefaultIcon(_ app: XCUIApplication, row: XCUIElement) {
        guard row.waitForExistence(timeout: 5) else { return }
        scrollToAppIconRow(app).tap()
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
