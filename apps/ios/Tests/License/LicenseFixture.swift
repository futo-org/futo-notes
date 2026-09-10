import Foundation

@testable import FutoNotesNative

/// A real, verifiable staging license.
///
/// These two strings are signed by the FUTO Notes staging org key — the one
/// `STAGING_PUBLIC_KEY_BASE64` bakes in — so they verify on any `.dev` build
/// exactly as a purchased staging license would: product futo-notes, issued
/// 2026-01-15, expiring 2029-01-15. The license key itself does not exist
/// server-side and does not need to; nothing here reaches the network.
///
/// They are deliberately not the conformance fixture's pair, whose key is
/// test-only and never baked into a build. Re-mint them with
/// `FUTO_NOTES_STAGING_KEY=… node scripts/gen-license-fixture.mjs --staging`
/// (the staging private key is never in this repo); the same pair is carried by
/// Android's `LicenseFixture.kt` and the FFI contract tests. If the staging key
/// is rotated without re-minting, these tests go red — the correct red.
enum LicenseFixture {
    static let key = "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78"
    static let activation =
        "v2.eyJrZXkiOiJGTi1BQjEyLUNEMzQtRUY1Ni1HSDc4LUpLMTItTU4zNC1QUTU2LVJTNzgiLCJwcm9kdWN0IjoiZnV0by1ub3RlcyIsImlzc3VlZF9hdCI6IjIwMjYtMDEtMTVUMTA6MzA6MDBaIiwiZXhwaXJlc19hdCI6IjIwMjktMDEtMTVUMTA6MzA6MDBaIn0.6Os6nS_93GOGFt5fd4k3XvtQsGMJ-x8Zct9RjZrZxdvHMAYtv6gvhvDcKf7sKzqk3eJZbtYuZDYwMykumVtESj-49_4HtolXbZRNyqJPzwZDmAWK7_9ZJuD50rxQokv1-p6oEdVX-eFANw9o0SI_kxEFQeVabto3ZwGEFqzNODlSObksC8SgmEbHfJFrtUgPXy8TbcRfFAsfNKSWFSvYEIRe2RFHcU9pG6XFd_h5kH0GGOjUmJM778C38rDyz6aedxVaMRkLjCfgJzaDqY7tB-c2ieYxjk_6AwPu3W2Sy4rDhJlFOdWghG96j0LOaQgc-wS_gyqQysPJBtw5G03fZg"

    /// What the FUTOpay activate-redirect page opens.
    static var deepLink: String { "futonotes://license/\(key)/\(activation)" }

    /// The dev bundle id both the simulator and device debug builds run under.
    static let devBundleId = "com.futo.notes.dev"
    static let releaseBundleId = "com.futo.notes"

}

/// An in-memory stand-in for `UserDefaults`, so no test can read or write the
/// simulator's real license — and so a test run leaves nothing behind in the
/// app container (a `UserDefaults(suiteName:)` writes a plist there that
/// outlives `removePersistentDomain`).
final class InMemoryLicenseDefaults: LicenseDefaults, @unchecked Sendable {
    private var values: [String: String] = [:]
    private(set) var readOccurredOnMainThread = false

    func string(forKey defaultName: String) -> String? {
        if Thread.isMainThread { readOccurredOnMainThread = true }
        return values[defaultName]
    }

    func set(_ value: Any?, forKey defaultName: String) {
        guard let string = value as? String else {
            values.removeValue(forKey: defaultName)
            return
        }
        values[defaultName] = string
    }

    func removeObject(forKey defaultName: String) {
        values.removeValue(forKey: defaultName)
    }
}
