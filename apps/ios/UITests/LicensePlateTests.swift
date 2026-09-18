import XCTest

/// The License plate, driven in the real app.
///
/// This is a UI test and not a unit test because what the 2026-09-18 port
/// changed is what the plate PUTS ON SCREEN — an empty well removed, a
/// letterhead that belongs only to a stored license, a reason moved above the
/// button it argues for, a Copy control taken away. `licensePlateShape` locks
/// the decisions; only a running app can say they reached the screen.
///
/// It is also, on this machine, the only way to drive the plate at all: an
/// Xcode 27 install with no Simulator.app has no window for `axe tap` to tap
/// into, while XCUITest injects events into the app process and works normally.
///
/// The three attachments are the screenshots a human would otherwise take by
/// hand — Unlicensed, the coin burst in flight, and the settled Licensed card.
final class LicensePlateTests: XCTestCase {
    /// The staging-signed pair, straight out of `LicenseFixture` — the same
    /// file the unit tests use, compiled into this target by `project.yml` so
    /// there is no fourth copy of it to keep in step.
    private var deepLink: URL { URL(string: LicenseFixture.deepLink)! }

    @MainActor
    func testUnlicensedIsAnAskAndActivatingItMakesACard() {
        let app = makeIsolatedApplication()
        app.launch()

        let settings = app.buttons["nav-settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 20))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))

        // `makeIsolatedApplication` isolates the vault, not `UserDefaults` —
        // which is where the license lives, and which survives a run. A pooled
        // simulator can therefore arrive already licensed from somebody else's
        // session, so start by putting it back to Unlicensed. Remove exists for
        // exactly this (docs/spec/license.md: "for testing and device
        // hand-off"), and tapping it here also proves it works.
        let remove = app.buttons["license-remove"]
        if remove.waitForExistence(timeout: 10) { remove.tap() }

        // ── Unlicensed: an ask, not a card ──────────────────────────────────
        let headline = app.staticTexts["license-headline"]
        XCTAssertTrue(headline.waitForExistence(timeout: 10), "the ask never appeared")
        // No empty well — an empty circle read as something that had failed to
        // load rather than as "no license".
        XCTAssertFalse(app.images["license-well"].exists, "Unlicensed reserved a well")
        // No letterhead: the badge belongs to a card, and this state has none.
        XCTAssertFalse(app.staticTexts["license-status"].exists, "Unlicensed wore a badge")
        // No ledger: one blank Key row is the same void the well was.
        XCTAssertFalse(app.buttons["license-key-masked"].exists, "Unlicensed had a key row")

        // The reason sits ABOVE the button it argues for. Source order proves
        // nothing, so this reads the two frames.
        let reason = app.staticTexts["license-explanation"]
        let buy = app.buttons["license-buy"]
        XCTAssertTrue(reason.exists && buy.exists)
        XCTAssertLessThan(
            reason.frame.minY, buy.frame.minY,
            "the mission paragraph must sit above Buy, not under it")
        XCTAssertTrue(app.buttons["license-enter-key"].exists)
        XCTAssertTrue(app.buttons["license-lost-key"].exists)
        attach(app, named: "unlicensed")

        // ── Activation: the OS hands over the link, exactly as FUTOpay's
        //    activate-redirect page does after a purchase ──────────────────────
        XCUIDevice.shared.system.open(deepLink)

        let masked = app.buttons["license-key-masked"]
        XCTAssertTrue(masked.waitForExistence(timeout: 15), "the link did not license the device")
        // The burst is a decorative canvas with nothing in the accessibility
        // tree, by design — these catch it mid-flight for the attachments. Two
        // of them, a second apart: one frame cannot tell a burst in flight from
        // a burst that never moved, which is exactly the bug the first version
        // of the iOS shower had.
        attach(app, named: "activation-burst")
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        attach(app, named: "activation-burst-later")

        // ── Licensed: the coin, the letterhead, and Key as the whole ledger ──
        XCTAssertTrue(app.images["license-well"].exists, "the coin's well is missing")
        XCTAssertFalse(app.staticTexts["license-status"].exists, "Licensed wore a badge")
        XCTAssertTrue(app.buttons["license-remove"].exists)
        XCTAssertFalse(app.buttons["license-buy"].exists)
        // "Licensed since" and "Term" are gone as ROWS. `licenseCardModel` still
        // returns both — it is shared law across the three shells — so what is
        // asserted is the screen: neither label reached it.
        XCTAssertFalse(app.staticTexts["Licensed since"].exists)
        XCTAssertFalse(app.staticTexts["Term"].exists)
        XCTAssertFalse(app.staticTexts["Perpetual"].exists)

        // Reveal is a look and nothing more: no Copy control follows it, because
        // a license key should not be one tap from the clipboard.
        masked.tap()
        let revealed = app.staticTexts["license-key-revealed"]
        XCTAssertTrue(revealed.waitForExistence(timeout: 5))
        XCTAssertEqual(revealed.label, LicenseFixture.key)
        XCTAssertFalse(app.buttons["license-key-copy"].exists, "a Copy key control came back")

        // Let the burst finish, so the attachment shows the card it leaves
        // behind rather than coins still in the air.
        RunLoop.current.run(until: Date().addingTimeInterval(4))
        attach(app, named: "licensed")
        // A second look a moment later: the coin is a metal turning on a
        // spindle, and one still frame of it says nothing about whether it is
        // lit or merely showing its dark rim.
        RunLoop.current.run(until: Date().addingTimeInterval(1.2))
        attach(app, named: "licensed-turned")

        // Hand the pooled simulator back the way this test would like to find
        // it: the license is this app's only cross-run state.
        app.buttons["license-remove"].tap()
        XCTAssertTrue(app.staticTexts["license-headline"].waitForExistence(timeout: 10))
    }

    @MainActor
    private func attach(_ app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
