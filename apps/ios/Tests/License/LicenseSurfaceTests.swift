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

    /// The plate's four independent yes/no answers, once per state. Each is a
    /// desktop decision this shell was two rounds behind on until 2026-09-18
    /// (docs/spec/license.md § States and copy).
    @Test("the well, the letterhead and the ledger all belong to a stored license")
    func plateShapePerState() {
        let localization = Localization.system(
            requestedLanguageTags: ["en"], regionalLanguageTag: "en-US")
        func card(_ view: LicenseView) -> LicenseCardModel { licenseCardModel(view, localization) }
        let key = "AB12-CD34-EF56-GH78-JK9M-NP2Q-RS3T-6UJV"

        // Unlicensed is an ask, not a card: no well to read as a failed load,
        // no letterhead, and no lone blank row standing in for a ledger.
        let unlicensed = card(
            LicenseView(status: .unlicensed, issuedAtMillis: nil, expiresAtMillis: nil, key: nil))
        #expect(
            licensePlateShape(unlicensed)
                == LicensePlateShape(
                    well: false, letterhead: false, keyRow: false, headline: true))

        // Licensed is the only state with a coin, and the only state with no
        // headline and no badge.
        let licensed = card(
            LicenseView(status: .licensed, issuedAtMillis: nil, expiresAtMillis: nil, key: key))
        #expect(
            licensePlateShape(licensed)
                == LicensePlateShape(
                    well: true, letterhead: true, keyRow: true, headline: false))
        #expect(licensed.badge == nil)

        // Expired has paid once: it keeps the letterhead and the key, wears its
        // badge, and has no coin in the well it no longer reserves.
        let expired = card(
            LicenseView(
                status: .expired, issuedAtMillis: 1_704_196_800_000,
                expiresAtMillis: 1_735_819_200_000, key: key))
        #expect(
            licensePlateShape(expired)
                == LicensePlateShape(
                    well: false, letterhead: true, keyRow: true, headline: false))
        #expect(expired.badge != nil)
    }

    /// Before the stored pair has been read there is no state to claim, so the
    /// plate renders its frame and says nothing (M1).
    @Test("an unread license puts nothing on the plate")
    func plateShapeBeforeLoad() {
        #expect(
            licensePlateShape(nil)
                == LicensePlateShape(
                    well: false, letterhead: false, keyRow: false, headline: false))
    }

    /// The card model keeps returning `since` and `term` — it is shared law
    /// across the three shells and did not change — and this shell stopped
    /// rendering them. The catalog is what proves the second half: the two row
    /// LABELS were only ever read here and on Android, so they left
    /// `languages/en.json` with their last reader, and so did Copy key and its
    /// toast and the empty well's label.
    ///
    /// `localizedText` answers an unknown path with the path itself, which is
    /// what makes this assertion possible at all.
    @Test("the retired card entries are gone from the shipped catalog")
    func retiredCatalogEntries() {
        let localization = Localization.system(
            requestedLanguageTags: ["en"], regionalLanguageTag: "en-US")
        for path in [
            "license.card.sinceLabel", "license.card.termLabel", "license.card.copyKey",
            "license.card.keyCopied", "license.card.emptyWell",
        ] {
            #expect(localization.localizedText(path) == path, "\(path) is still in the catalog")
        }
        // The term STRINGS stay: `licenseCardModel` still builds them, and its
        // own tests still read them.
        #expect(localization.localizedText("license.card.termPerpetual") == "Perpetual")
    }
}
