import StoreKitTest
import XCTest

/// The App Store-only purchase (ADR-0009), driven in the real app against
/// StoreKit's local test environment (`StoreKit/FutoNotes.storekit`). The
/// session belongs to this process and reaches the app under test through the
/// simulator's StoreKit daemon, so the app buys, restores and is refunded with
/// no App Store account.
///
/// Each test starts from a cleared session and an Unlicensed key: the license
/// key is the app's only cross-run state, and the purchase lives in the
/// session.
final class AppStorePurchaseTests: XCTestCase {
    private var session: SKTestSession!

    override func setUpWithError() throws {
        continueAfterFailure = false
        session = try SKTestSession(configurationFileNamed: "FutoNotes")
        session.resetToDefaultState()
        session.clearTransactions()
        session.disableDialogs = true
        session.askToBuyEnabled = false
    }

    override func tearDownWithError() throws {
        session.clearTransactions()
    }

    #if DEBUG
        /// US: the website and the App Store side by side with equal weight, a
        /// caption under each, and the rest as list rows under the card.
        @MainActor
        func testUSCardOffersBothBuysWithEqualWeight() {
            let app = launchToSettings(storefront: "USA")
            let buy = app.buttons["license-buy"]
            let appStore = app.buttons["license-buy-app-store"]
            XCTAssertTrue(appStore.waitForExistence(timeout: 15), "the product never loaded")
            XCTAssertTrue(buy.exists)
            XCTAssertLessThan(
                buy.frame.minX, appStore.frame.minX, "website first, then the App Store")
            XCTAssertEqual(buy.frame.minY, appStore.frame.minY, accuracy: 0.5, "side by side")
            XCTAssertEqual(buy.frame.width, appStore.frame.width, accuracy: 0.5, "equal weight")
            XCTAssertEqual(buy.frame.height, appStore.frame.height, accuracy: 0.5, "equal weight")
            XCTAssertEqual(
                app.staticTexts["license-buy-caption"].label,
                "Every platform,\nwith a license key")
            XCTAssertEqual(
                app.staticTexts["license-app-store-scope"].label,
                "iPhone and iPad,\nno license key")
            XCTAssertTrue(app.buttons["license-enter-key"].exists)
            XCTAssertTrue(app.buttons["license-restore-purchases"].exists)
            XCTAssertTrue(app.buttons["license-lost-key"].exists)
            attach(app, named: "us-unlicensed")

            // The icon ask offers the same pair.
            let row = app.buttons["settings-app-icon"]
            while !row.isHittable { app.swipeUp() }
            row.tap()
            let tile = app.buttons.matching(
                NSPredicate(format: "label ENDSWITH %@", "included with a license")
            ).firstMatch
            XCTAssertTrue(tile.waitForExistence(timeout: 10))
            tile.tap()
            let sheetBuy = app.buttons["app-icon-ask-buy"]
            let sheetAppStore = app.buttons["app-icon-ask-buy-app-store"]
            XCTAssertTrue(sheetAppStore.waitForExistence(timeout: 10))
            XCTAssertEqual(sheetBuy.frame.minY, sheetAppStore.frame.minY, accuracy: 0.5)
            XCTAssertEqual(sheetBuy.frame.width, sheetAppStore.frame.width, accuracy: 0.5)
            XCTAssertTrue(app.buttons["app-icon-ask-already-paid"].exists)
            XCTAssertTrue(app.buttons["app-icon-ask-not-now"].exists)
            attach(app, named: "us-icon-sheet")
        }

        /// Elsewhere: the key leads, the App Store is a labeled secondary button,
        /// and nothing names the website.
        @MainActor
        func testNonUSCardKeepsTheKeyFirst() {
            let app = launchToSettings(storefront: "FRA")
            let appStore = app.buttons["license-buy-app-store"]
            XCTAssertTrue(appStore.waitForExistence(timeout: 15), "the product never loaded")
            let enterKey = app.buttons["license-enter-key"]
            XCTAssertLessThan(enterKey.frame.minY, appStore.frame.minY, "the key field leads")
            XCTAssertFalse(app.buttons["license-buy"].exists)
            XCTAssertFalse(app.buttons["license-lost-key"].exists)
            XCTAssertEqual(
                app.staticTexts["license-app-store-scope"].label,
                "Works in FUTO Notes on iPhone and iPad with your Apple Account. It doesn't come with a license key, so it can't be used on other platforms."
            )
            XCTAssertTrue(app.buttons["license-restore-purchases"].exists)
            attach(app, named: "fra-unlicensed")
        }

        /// Buying from the icon sheet lands on the picker exactly like a key
        /// activation, and the icon is then choosable.
        @MainActor
        func testBuyingFromTheIconSheetLandsInThePicker() {
            let app = launchToSettings(storefront: "FRA")
            XCTAssertTrue(app.buttons["license-buy-app-store"].waitForExistence(timeout: 15))
            let row = app.buttons["settings-app-icon"]
            while !row.isHittable { app.swipeUp() }
            row.tap()
            // Any coined tile: the current icon has no coin and asks nothing,
            // and an earlier run may have left any icon current.
            let tile = app.buttons.matching(
                NSPredicate(format: "label ENDSWITH %@", "included with a license")
            ).firstMatch
            XCTAssertTrue(tile.waitForExistence(timeout: 10))
            tile.tap()
            let sheetBuy = app.buttons["app-icon-ask-buy-app-store"]
            XCTAssertTrue(sheetBuy.waitForExistence(timeout: 10))
            attach(app, named: "icon-sheet")
            sheetBuy.tap()

            XCTAssertTrue(
                app.descendants(matching: .any)["app-icon-landing"].waitForExistence(timeout: 20),
                "the purchase did not land on the picker")
            XCTAssertFalse(app.buttons["app-icon-ask-buy-app-store"].exists, "the ask stayed up")
            XCTAssertFalse(app.staticTexts["app-icon-footnote"].exists)
            attach(app, named: "landed")

            app.navigationBars["App icon"].buttons["Done"].tap()
            // Settings is still scrolled to the App icon row; the card is above.
            let title = app.staticTexts["license-app-store-title"]
            for _ in 0..<4 where !title.exists { app.swipeDown() }
            XCTAssertTrue(title.waitForExistence(timeout: 10))
            XCTAssertFalse(app.buttons["license-remove"].exists, "a purchase cannot be removed")
            XCTAssertTrue(app.buttons["license-enter-key"].exists)
            attach(app, named: "purchased")
        }

        /// Restore with nothing bought says so; a purchase already on the account
        /// is there at launch, with no tap at all.
        @MainActor
        func testRestore() async throws {
            let app = launchToSettings(storefront: "USA")
            let restore = app.buttons["license-restore-purchases"]
            XCTAssertTrue(restore.waitForExistence(timeout: 15))
            restore.tap()
            XCTAssertTrue(
                app.staticTexts["No App Store purchase to restore for this Apple Account."]
                    .waitForExistence(timeout: 15))
            app.terminate()

            try await session.buyProduct(identifier: "com.futo.notes.license")
            let relaunched = launchToSettings(storefront: "USA")
            XCTAssertTrue(
                relaunched.staticTexts["license-app-store-title"].waitForExistence(timeout: 15))
        }

        /// A refund takes the purchase away live; the picker asks again.
        @MainActor
        func testRefundReturnsTheAsk() async throws {
            try await session.buyProduct(identifier: "com.futo.notes.license")
            let app = launchToSettings(storefront: "USA")
            XCTAssertTrue(app.staticTexts["license-app-store-title"].waitForExistence(timeout: 15))

            let purchases = session.allTransactions().filter {
                $0.productIdentifier == "com.futo.notes.license"
            }
            XCTAssertFalse(purchases.isEmpty)
            for purchase in purchases {
                try session.refundTransaction(identifier: UInt(purchase.identifier))
            }
            XCTAssertTrue(app.buttons["license-buy-app-store"].waitForExistence(timeout: 15))
            XCTAssertFalse(app.staticTexts["license-app-store-title"].exists)
        }
    #endif

    @MainActor
    private func launchToSettings(storefront: String) -> XCUIApplication {
        let app = makeIsolatedApplication()
        app.launchArguments += ["-FUTOLicenseStorefront", storefront]
        app.launch()
        let settings = app.buttons["nav-settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 20))
        settings.tap()
        let remove = app.buttons["license-remove"]
        if remove.waitForExistence(timeout: 5) { remove.tap() }
        return app
    }

    @MainActor
    private func attach(_ app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
