import Foundation

@testable import FutoNotesNative

/// A real, verifiable staging license.
///
/// The staging environment's baked-in key IS the conformance fixture's key pair
/// (`STAGING_PUBLIC_KEY_BASE64`, and the placeholder-keys Gap in
/// docs/spec/license.md), so these two strings — `tests/conformance/license.json`,
/// `licenseKey[0]` and `namedActivations.valid` — verify on any `.dev` build:
/// product futo-notes, issued 2026-01-15, expiring 2029-01-15. If the fixture
/// pair is ever regenerated the signature stops verifying and these tests go
/// red, which is the correct red.
enum LicenseFixture {
    static let key = "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78"
    static let activation =
        "v2.eyJrZXkiOiJGTi1BQjEyLUNEMzQtRUY1Ni1HSDc4LUpLMTItTU4zNC1QUTU2LVJTNzgiLCJwcm9kdWN0IjoiZnV0by1ub3RlcyIsImlzc3VlZF9hdCI6IjIwMjYtMDEtMTVUMTA6MzA6MDBaIiwiZXhwaXJlc19hdCI6IjIwMjktMDEtMTVUMTA6MzA6MDBaIn0.UW-vdWiyHl70QilqDEJH0xHKaJAuqfArW_UqEIoIqytuSl-y5bwaHh-0r1KSLqGjs9q7E77X3UshG4iBnyheH84FslCUGrs5CV0QUeUd1SLym_g2dAi4XkI7RN8QoDKVY9V4ddYd13lbvIATbgMxA_MDlKalkmvUhJ0gkxjoN2jQnf4SmUivPp38ZuwscHrorA-iy1BQhobXS3lbws9ENO4FcknQ1A5TzWvQJ1hkUagQpWnXj1NIyOYcfqHaWSe0TD5HdXKacDVQftb_puM8YbQ5uHYSxgMdQ_rol6dKYijX0u7IhN9WuKnCTL26_bwpwbEUtAmNDr9SKVU1iO9_Gg"

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
