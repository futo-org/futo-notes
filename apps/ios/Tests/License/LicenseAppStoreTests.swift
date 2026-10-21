import Foundation
import StoreKit
import StoreKitTest
import Testing

@testable import FutoNotesNative

/// The App Store-only purchase (ADR-0009) against StoreKit's local test
/// environment, configured by `StoreKit/FutoNotes.storekit` — the same file
/// the Debug scheme runs with. One SKTestSession is global to the process, so
/// the suite is serialized and every test starts from a cleared session.
@MainActor
@Suite(
    "License App Store purchase", .serialized,
    .enabled(
        "no local StoreKit test environment on this simulator (runtime must match Xcode's SDK)",
        { await StoreKitTestEnvironment.shouldRun() }))
struct LicenseAppStoreTests {
    private func session() async throws -> SKTestSession {
        try #require(
            await StoreKitTestEnvironment.answers(),
            """
            StoreKit's local test environment did not load the product on this simulator: \
            use a simulator runtime matching Xcode's iOS SDK (a freshly erased one answers \
            from its second run), or set FUTO_STOREKIT_TESTS_OPTIONAL=1 to skip these tests
            """)
        let session = try SKTestSession(configurationFileNamed: "FutoNotes")
        session.resetToDefaultState()
        session.clearTransactions()
        session.disableDialogs = true
        session.askToBuyEnabled = false
        return session
    }

    private func loaded() async -> LicenseAppStore {
        let store = LicenseAppStore()
        await store.refreshOwned()
        await store.loadProduct()
        return store
    }

    @Test("the product id is Rust's, and it loads from the configuration")
    func productLoads() async throws {
        _ = try await session()
        let store = await loaded()
        #expect(store.productID == "com.futo.notes.license")
        #expect(store.offered)
        #expect(!store.owned)
    }

    /// No product (not in App Store Connect yet, or StoreKit failed): the
    /// card simply has no App Store controls.
    @Test("a product that does not load is not offered, and Buy does nothing")
    func missingProductIsNotOffered() async throws {
        _ = try await session()
        let store = LicenseAppStore(productID: "com.futo.notes.missing")
        await store.loadProduct()
        #expect(!store.offered)
        #expect(await store.buy() == false)
    }

    @Test("buying owns it, and a fresh launch still owns it")
    func buyOwns() async throws {
        _ = try await session()
        let store = await loaded()
        #expect(await store.buy())
        #expect(store.owned)

        let relaunched = await loaded()
        #expect(relaunched.owned)
    }

    /// Ask to Buy: the purchase waits on a parent and changes nothing yet.
    /// Compared with what was owned before rather than with "not owned": a
    /// cleared session can still list an earlier test's purchase (CI job
    /// 270810 failed here on exactly that), and `buy()` must answer false for
    /// a pending purchase either way.
    @Test("a pending purchase changes nothing")
    func pendingChangesNothing() async throws {
        let session = try await session()
        session.askToBuyEnabled = true
        let store = await loaded()
        let ownedBefore = store.owned
        #expect(await store.buy() == false)
        #expect(store.owned == ownedBefore)
    }

    @Test("restore finds a purchase made on this account")
    func restoreFindsThePurchase() async throws {
        let session = try await session()
        try await session.buyProduct(identifier: "com.futo.notes.license")
        let store = LicenseAppStore()
        await store.loadProduct()
        #expect(await store.restore())
        #expect(store.owned)
    }

    @Test("restore with nothing bought owns nothing")
    func restoreWithNothing() async throws {
        _ = try await session()
        let store = await loaded()
        #expect(await store.restore() == false)
    }

    /// The gate is on choosing, never keeping (D2): a refund takes the
    /// purchase away; the icon already set stays (that is the picker's rule).
    @Test("a refund clears ownership, live and on the next launch")
    func refundClears() async throws {
        let session = try await session()
        let store = LicenseAppStore()
        let observing = Task { await store.observe() }
        defer { observing.cancel() }
        try await waitUntil { store.offered }
        #expect(await store.buy())

        // Every transaction for the product: a cleared session can still
        // list an earlier test's, and refunding only that one leaves this
        // purchase owned.
        let purchases = session.allTransactions().filter {
            $0.productIdentifier == store.productID
        }
        try #require(!purchases.isEmpty)
        for purchase in purchases {
            try session.refundTransaction(identifier: UInt(purchase.identifier))
        }
        try await waitUntil { !store.owned }

        let relaunched = await loaded()
        #expect(!relaunched.owned)
    }

    /// The model: the App Store fact goes to Rust as evidence, and the plate,
    /// includes and controls come back from it.
    @Test("an owned purchase includes the icon, shows its own plate and lands once")
    func modelFollowsThePurchase() async throws {
        _ = try await session()
        let appStore = await loaded()
        let license = LicenseModel(
            storage: LicenseStorage(defaults: InMemoryLicenseDefaults()),
            bundleId: LicenseFixture.devBundleId, appStore: appStore)
        await license.load()
        #expect(license.plate == .unlicensed)
        #expect(license.includes.isEmpty)
        #expect(
            license.rowActions(linkOut: false) == [.enterKey, .buyInAppStore, .restorePurchases])
        #expect(
            license.rowActions(linkOut: true) == [
                .buy, .buyInAppStore, .enterKey, .restorePurchases, .lostKey,
            ])

        await license.buyInAppStore()
        #expect(license.plate == .appStore)
        #expect(license.includes == [.appIcon])
        #expect(license.pendingLanding)
        #expect(license.rowActions(linkOut: true) == [.enterKey])

        // A key entered later wins the plate; removing it falls back to the
        // purchase, which an Apple Account cannot remove.
        license.consumeLanding()
        license.handle(URL(string: LicenseFixture.deepLink)!)
        #expect(license.plate == .licensed)
        license.remove()
        #expect(license.plate == .appStore)
        #expect(license.includes == [.appIcon])
    }

    @Test("restoring nothing says so and changes nothing")
    func modelRestoreWithNothing() async throws {
        _ = try await session()
        let appStore = await loaded()
        let license = LicenseModel(
            storage: LicenseStorage(defaults: InMemoryLicenseDefaults()),
            bundleId: LicenseFixture.devBundleId, appStore: appStore)
        var messages: [String] = []
        license.showMessage = { messages.append($0.path) }
        await license.load()

        await license.restorePurchases()
        #expect(messages == ["license.appStore.nothingToRestore"])
        #expect(license.plate == .unlicensed)
        #expect(!license.pendingLanding)
    }

    @Test("no product, no App Store controls")
    func modelWithoutProduct() async throws {
        _ = try await session()
        let appStore = LicenseAppStore(productID: "com.futo.notes.missing")
        await appStore.loadProduct()
        let license = LicenseModel(
            storage: LicenseStorage(defaults: InMemoryLicenseDefaults()),
            bundleId: LicenseFixture.devBundleId, appStore: appStore)
        await license.load()
        #expect(license.rowActions(linkOut: false) == [.enterKey])
    }

    private func waitUntil(
        timeout: Duration = .seconds(10), _ condition: @MainActor () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            if ContinuousClock.now > deadline {
                Issue.record("condition not met within \(timeout)")
                return
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
}

/// Whether StoreKit's local test environment answers. When it does not, no
/// product loads and `AppStore.sync()` waits forever on an Apple Account
/// sign-in, so the suite hangs rather than fails. Seen on the Mac with
/// Xcode 27.1: an iOS 26.5 simulator never answers (every `SKTestSession` call
/// logs `SKInternalErrorDomain` 3 without throwing), and a freshly erased
/// iOS 27.1 one not on its first run. Probed once per process: an unusable
/// environment fails every test at its first line, unless the run opted out
/// with `FUTO_STOREKIT_TESTS_OPTIONAL=1` (`just test-ios-native` passes it as
/// `TEST_RUNNER_…`), which skips the suite with its reason. CI never opts out,
/// so there it stays a failure (M11).
@MainActor private enum StoreKitTestEnvironment {
    private static var probe: Task<Bool, Never>?

    static func answers() async -> Bool {
        if let probe { return await probe.value }
        let loading = Task {
            guard let session = try? SKTestSession(configurationFileNamed: "FutoNotes")
            else { return false }
            session.resetToDefaultState()
            session.clearTransactions()
            let products = try? await Product.products(for: [licenseAppStoreProductId()])
            return products?.isEmpty == false
        }
        probe = loading
        return await loading.value
    }

    static func shouldRun() async -> Bool {
        let optional = ProcessInfo.processInfo.environment["FUTO_STOREKIT_TESTS_OPTIONAL"] == "1"
        return await answers() || !optional
    }
}
