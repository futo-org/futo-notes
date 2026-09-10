import Foundation
import Testing

@testable import FutoNotesNative

@Suite("License storage")
struct LicenseStorageTests {
    /// The whole point of storage: what was accepted is what comes back, byte
    /// for byte. base64url is case-sensitive, so an activation "helpfully"
    /// normalized on the way through stops verifying.
    @Test("a stored pair round-trips unchanged")
    func roundTrips() {
        let storage = LicenseStorage(defaults: InMemoryLicenseDefaults())
        let pair = LicensePair(key: LicenseFixture.key, activation: "v2.aBcD_-eF.gH-iJ_kL")

        storage.write(pair)

        #expect(storage.read()?.key == pair.key)
        #expect(storage.read()?.activation == pair.activation)
    }

    /// Reading is the app's first license question on every launch, so
    /// "nothing stored" has to be an answer, not a failure.
    @Test("an empty store reads as no license")
    func emptyReadsAsNoLicense() {
        #expect(LicenseStorage(defaults: InMemoryLicenseDefaults()).read() == nil)
    }

    /// A half-written pair must not become a license that can never verify —
    /// that renders as Unlicensed anyway, but only after a pointless RSA check
    /// on every read.
    @Test("a half-written pair reads as no license")
    func halfWrittenReadsAsNoLicense() {
        let defaults = InMemoryLicenseDefaults()
        defaults.set(LicenseFixture.key, forKey: LicenseStorage.keyDefaultsKey)
        defaults.set("   ", forKey: LicenseStorage.activationDefaultsKey)

        #expect(LicenseStorage(defaults: defaults).read() == nil)
    }

    /// Remove asks for no confirmation and is reversible, so it must also be
    /// idempotent: clearing twice, or with nothing stored, is success.
    @Test("clearing is idempotent")
    func clearingIsIdempotent() {
        let storage = LicenseStorage(defaults: InMemoryLicenseDefaults())
        storage.write(LicensePair(key: LicenseFixture.key, activation: LicenseFixture.activation))

        storage.clear()
        storage.clear()

        #expect(storage.read() == nil)
    }
}
