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

    /// The card's Key row, at the seam the view renders from: masked by
    /// default, the stored key once revealed, and nothing at all with no
    /// license (decision D4). Asserted here rather than through a hosted
    /// SwiftUI view, which would test SwiftUI and not the rule.
    @Test("the card shows the masked key and reveals on tap")
    func keyRowMasksAndReveals() {
        let localization = Localization.system(
            requestedLanguageTags: ["en"], regionalLanguageTag: "en-US")
        let key = "AB12-CD34-EF56-GH78-JK9M-NP2Q-RS3T-6UJV"
        let licensed = licenseCardModel(
            LicenseView(
                status: .licensed, issuedAtMillis: nil, expiresAtMillis: nil, key: key),
            localization)

        let masked = licenseKeyRowText(licensed, key: key, revealed: false)
        // Only the last group survives, and the key itself is never in the
        // masked string.
        #expect(masked == "···· ···· ···· ···· ···· ···· ···· 6UJV")
        #expect(masked?.contains("AB12") == false)

        // The tap swaps the same row to the stored key, verbatim — the card
        // never re-cases or re-groups what Rust normalized.
        #expect(licenseKeyRowText(licensed, key: key, revealed: true) == key)

        // Revealing something that is not there is not a state the row can be
        // put in: an unlicensed card has no key row at all.
        let unlicensed = licenseCardModel(
            LicenseView(
                status: .unlicensed, issuedAtMillis: nil, expiresAtMillis: nil, key: nil),
            localization)
        #expect(licenseKeyRowText(unlicensed, key: nil, revealed: false) == nil)
        #expect(licenseKeyRowText(unlicensed, key: nil, revealed: true) == nil)

        // A licensed card whose key went missing stays masked rather than
        // rendering an empty row where the key was.
        #expect(licenseKeyRowText(licensed, key: nil, revealed: true) == masked)
    }
}
