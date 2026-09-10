import Foundation
import Testing

@testable import FutoNotesNative

@MainActor
@Suite("License model")
struct LicenseModelTests {
    private func model(bundleId: String = LicenseFixture.devBundleId) -> (
        LicenseModel, InMemoryLicenseDefaults
    ) {
        let defaults = InMemoryLicenseDefaults()
        return (
            LicenseModel(storage: LicenseStorage(defaults: defaults), bundleId: bundleId), defaults
        )
    }

    /// The row must be right on the FIRST paint: reading and verifying a stored
    /// license is pure CPU, so nothing is awaited and Settings never flashes
    /// Unlicensed before correcting itself (M1).
    @Test("a stored license is evaluated before anything renders")
    func evaluatesStoredLicenseAtInit() {
        let defaults = InMemoryLicenseDefaults()
        LicenseStorage(defaults: defaults).write(
            LicensePair(key: LicenseFixture.key, activation: LicenseFixture.activation))

        let license = LicenseModel(
            storage: LicenseStorage(defaults: defaults), bundleId: LicenseFixture.devBundleId)

        #expect(license.view.status == .licensed)
        // 2026-01-15T10:30:00Z, the fixture license's purchase instant.
        #expect(license.view.issuedAtMillis == 1_768_473_000_000)
    }

    /// CRITICAL (M3). The same staging license verifies on the `.dev` build and
    /// fails closed on the release build — and the selector is the bundle id,
    /// never a compile profile: both dev apps ship the optimized `release-ffi`
    /// Rust.
    @Test("a staging license is invisible to a release build")
    func stagingLicenseFailsClosedOnRelease() {
        let defaults = InMemoryLicenseDefaults()
        LicenseStorage(defaults: defaults).write(
            LicensePair(key: LicenseFixture.key, activation: LicenseFixture.activation))

        let release = LicenseModel(
            storage: LicenseStorage(defaults: defaults), bundleId: LicenseFixture.releaseBundleId)

        #expect(release.view.status == .unlicensed)
    }

    /// A valid link replaces the stored license without confirmation and shows
    /// one toast. Storing the pair is the shell's only job here — the verdict
    /// arrived already made.
    @Test("a valid deep link stores the pair and announces it once")
    func validDeepLinkStoresAndToasts() {
        let (license, defaults) = model()
        var messages: [String] = []
        license.showMessage = { messages.append($0.path) }

        license.handle(URL(string: LicenseFixture.deepLink)!)

        #expect(license.view.status == .licensed)
        #expect(LicenseStorage(defaults: defaults).read()?.activation == LicenseFixture.activation)
        #expect(messages == ["license.activated"])
    }

    /// A link at a host or path this app does not define is ignored SILENTLY:
    /// no toast, no navigation, nothing stored.
    @Test("an undefined link is ignored silently")
    func undefinedLinkIsSilent() {
        let (license, defaults) = model()
        var messages: [String] = []
        license.showMessage = { messages.append($0.path) }

        license.handle(URL(string: "futonotes://settings/open")!)

        #expect(messages.isEmpty)
        #expect(license.view.status == .unlicensed)
        #expect(LicenseStorage(defaults: defaults).read() == nil)
    }

    /// The regression this pins: a launch URL can reach `.onOpenURL` before the
    /// app has wired up the banner, and a toast sent into a `nil` destination
    /// would simply vanish — the link applied, silently. The message is parked
    /// and flushed the moment there is somewhere to put it, exactly once.
    @Test("a cold-start link is announced once the banner exists")
    func coldStartMessageIsParkedUntilThereIsABanner() {
        let (license, _) = model()
        var messages: [String] = []

        license.handle(URL(string: LicenseFixture.deepLink)!)
        #expect(license.view.status == .licensed)

        license.showMessage = { messages.append($0.path) }
        #expect(messages == ["license.activated"])

        // Draining is the only read: re-wiring must not replay it.
        license.showMessage = { messages.append($0.path) }
        #expect(messages == ["license.activated"])
    }

    /// A license link that does not verify earns exactly one toast — and the
    /// license already on the device survives it untouched.
    @Test("an invalid license link changes nothing and says so once")
    func invalidLinkKeepsTheStoredLicense() {
        let (license, defaults) = model()
        // Wire the banner up first, and drain the activation message, so the
        // only message this test can see is the one the bad link produces.
        var messages: [String] = []
        license.showMessage = { messages.append($0.path) }
        license.handle(URL(string: LicenseFixture.deepLink)!)
        messages.removeAll()

        license.handle(URL(string: "futonotes://license/\(LicenseFixture.key)/v2.bm90.bm90")!)

        #expect(messages == ["license.linkInvalid"])
        #expect(license.view.status == .licensed)
        #expect(LicenseStorage(defaults: defaults).read()?.activation == LicenseFixture.activation)
    }

    @Test("remove returns the device to unlicensed")
    func removeClearsStorage() {
        let (license, defaults) = model()
        license.handle(URL(string: LicenseFixture.deepLink)!)

        license.remove()

        #expect(license.view.status == .unlicensed)
        #expect(LicenseStorage(defaults: defaults).read() == nil)
    }

    /// Full reset wipes the license like every other preference (settings.md,
    /// Danger zone) — and does it without a toast, since the user is already
    /// looking at the result of a reset.
    @Test("full reset wipes the stored license")
    func fullResetClearsTheLicense() async {
        let (license, defaults) = model()
        var messages: [String] = []
        license.showMessage = { messages.append($0.path) }
        license.handle(URL(string: LicenseFixture.deepLink)!)
        messages.removeAll()

        await performFullReset(
            disconnectSync: {}, resetStore: {}, clearLicense: { license.clearForFullReset() })

        #expect(license.view.status == .unlicensed)
        #expect(LicenseStorage(defaults: defaults).read() == nil)
        #expect(messages.isEmpty)
    }

    /// Pasting the pair into the key field is the same workflow as the link,
    /// and it must never touch the network: the activation is already in hand.
    @Test("a pasted key/activation pair activates offline")
    func pastedPairActivates() async {
        let (license, defaults) = model()

        let accepted = await license.enterKey(
            "\(LicenseFixture.key)/\(LicenseFixture.activation)")

        #expect(accepted)
        #expect(license.view.status == .licensed)
        #expect(LicenseStorage(defaults: defaults).read()?.key == LicenseFixture.key)
    }

    /// Nothing is stored on a failure, so a bad paste leaves whatever was there
    /// alone — and the user is told the key is not valid, never why.
    @Test("an unrecognisable paste stores nothing")
    func rubbishPasteStoresNothing() async {
        let (license, defaults) = model()
        var messages: [String] = []
        license.showMessage = { messages.append($0.path) }

        let accepted = await license.enterKey("not a license at all")

        #expect(!accepted)
        #expect(messages == ["license.keyInvalid"])
        #expect(LicenseStorage(defaults: defaults).read() == nil)
    }
}
