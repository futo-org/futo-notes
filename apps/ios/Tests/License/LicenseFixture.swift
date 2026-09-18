import Foundation

/// A real, verifiable staging license, in both accepted activation formats.
///
/// These strings are signed by the FUTO Notes staging org key — the one
/// `STAGING_PUBLIC_KEY_BASE64` bakes in — so they verify on any `.dev` build
/// exactly as a purchased staging license would: product futo-notes, issued
/// 2026-01-15, expiring 2029-01-15. The license key itself does not exist
/// server-side and does not need to; nothing here reaches the network.
///
/// They are deliberately not the conformance fixture's pair, whose key is
/// test-only and never baked into a build. Re-mint them with
/// `FUTO_NOTES_STAGING_KEY=… node scripts/gen-license-fixture.mjs --staging`
/// (the staging private key is never in this repo); the same strings are carried
/// by Android's `LicenseFixture.kt` and the FFI contract tests. If the staging key
/// is rotated without re-minting, these tests go red — the correct red.
///
/// Deliberately free of `@testable import FutoNotesNative`: `apps/ios/project.yml`
/// compiles this one file into the UI-test target as well, so
/// `LicensePlateTests` drives the same pair through a real `futonotes://` link
/// without a fourth copy of it existing (`scripts/gen-license-fixture.mjs`
/// enumerates the consumers).
enum LicenseFixture {
    static let key = "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78"
    static let activation =
        "v2.eyJrZXkiOiJGTi1BQjEyLUNEMzQtRUY1Ni1HSDc4LUpLMTItTU4zNC1QUTU2LVJTNzgiLCJwcm9kdWN0IjoiZnV0by1ub3RlcyIsImlzc3VlZF9hdCI6IjIwMjYtMDEtMTVUMTA6MzA6MDBaIiwiZXhwaXJlc19hdCI6IjIwMjktMDEtMTVUMTA6MzA6MDBaIn0.FGk9lAe8Bh-RumaXsq5guBjWK_CnwZK1UI2qwyiA7_P1j5T-XnX9FJmPZGgaxbALE5vAJO4wqLbJwPduYQMJwQekUfHnh_wo5i4leOzaspS2NlUltCc7kDmB0--BVuWuxU5TWqHfmBop49MFfIZ4zysQ9WSvh8DQ77cJeOv8QI5Sg1y1ThMEeColOxM8QSITNMr3Zo1vAhZxYv4chJw1YQYjop_EAD18L-_oqrlk48v_9EeS-OoQar46Q0hoGR-TKP03TgZs18dVZIeJOZ_k9eQTHaE2vkNXvG59lTDvKyZSKouOJ2rgiyoZV0a65BujEN-rNOyatiauydFjCb2FSw"

    /// The same license key in the **v1** format — a bare base64url signature
    /// over the key, with no envelope and no payload. It is what
    /// `staging-pay2.futo.org` issues today, and it is Licensed with no
    /// purchase time and no expiry to show (issue #161).
    static let v1Activation =
        "bCGCpEu8pHvonpu0PS70awp-0mrKwow7FPDy583H8nAeqLc5_t7VjzyQzpKumfOX5sYQf9l2qjaGw5_LBdrBVjTYGi3sQhzHcIY2_s8SNZ5yGsFmWlDZjLrrp7yBY3l8GtV-kIoEpp9qfn3M5BNRcLtXzifP4Vqhn39H4czjimEpV_8yAeTVSOKoZC7icSTsucZ_0JdQuTCNVHJ6rkKd8UDnKsJiPreAymEFcXTSjKtGpLpMIf1TZELV_GkjRlg7cJF9uoneudD9rgPQM5j09kYmKSDnE8TarePm5JyCIM5HCXrBwOJGNh3qOhuediQb8yYu6u3cr06q6ZTqqeAIvw"

    /// What the FUTOpay activate-redirect page opens.
    static var deepLink: String { "futonotes://license/\(key)/\(activation)" }

    /// The same link carrying the v1 activation.
    static var v1DeepLink: String { "futonotes://license/\(key)/\(v1Activation)" }

    /// The dev bundle id both the simulator and device debug builds run under.
    static let devBundleId = "com.futo.notes.dev"
    static let releaseBundleId = "com.futo.notes"

}
