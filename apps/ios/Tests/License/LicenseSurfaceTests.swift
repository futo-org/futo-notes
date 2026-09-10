import Foundation
import Testing

@testable import FutoNotesNative

@Suite("License surface")
struct LicenseSurfaceTests {
    /// The scheme is registered at BUILD time, in `Info.plist`, where no test
    /// of the Rust rules can see it. This is the seam that catches a plist
    /// which lost the scheme — the deep link would then simply never arrive.
    @Test("the app registers the crate's URL scheme")
    func registersTheScheme() {
        let types =
            Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] ?? []
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }

        #expect(schemes.contains(licenseDeepLinkScheme()))
    }

    /// `LICENSE_LINK_OUT` is `true` at launch: the app ships the full surface
    /// worldwide (docs/spec/license.md § Store posture). This is the assertion
    /// to flip — together with the compile condition — if a store ever objects.
    @Test("the app links out at launch")
    func linksOutByDefault() {
        #if LICENSE_LINK_OUT_DISABLED
            #expect(!LicenseLinkOut.isEnabled)
        #else
            #expect(LicenseLinkOut.isEnabled)
        #endif
    }

    /// Both values of the flag, at the seam the row actually renders from, so
    /// the consumption-only shape is exercised without a build flip: Buy,
    /// Renew and Lost-your-key disappear and the key field stays.
    @Test("link-out false keeps the key field and hides every way out")
    func linkOutFalseHidesTheWaysOut() {
        #expect(
            licenseRowActions(status: .unlicensed, linkOut: true) == [.buy, .enterKey, .lostKey])
        #expect(
            licenseRowActions(status: .expired, linkOut: true) == [.renew, .enterKey, .lostKey])
        #expect(licenseRowActions(status: .unlicensed, linkOut: false) == [.enterKey])
        #expect(licenseRowActions(status: .expired, linkOut: false) == [.enterKey])
        #expect(licenseRowActions(status: .licensed, linkOut: false) == [.remove])
    }

    /// The Buy link carries this platform, and it is a plain https URL the
    /// system browser can open — never an in-app WebView target.
    @Test("the buy link is this platform's")
    func buyLinkIsIos() {
        let links = licenseLinks(platform: .ios, bundleId: "com.futo.notes")
        #expect(links.buy.contains("platform=ios"))
        #expect(links.support == "mailto:support@futo.tech")
    }

    /// The Buy destination follows the dev/prod split (M3), so the dev build
    /// that verifies against the staging key also buys on staging.
    @Test("the buy link follows the environment")
    func buyLinkFollowsEnvironment() {
        let staging = licenseLinks(platform: .ios, bundleId: "com.futo.notes.dev").buy
        let production = licenseLinks(platform: .ios, bundleId: "com.futo.notes").buy
        #expect(staging.hasPrefix("https://staging-pay2.futo.org/"))
        #expect(production.hasPrefix("https://pay2.futo.org/"))
    }
}
