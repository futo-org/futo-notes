import Foundation
import Testing

@testable import FutoNotesNative

@Suite("License copy")
struct LicenseCopyTests {
    private let localization = Localization.system(
        requestedLanguageTags: ["en"], regionalLanguageTag: "en-US")

    /// The fixture license's instants, as the epoch milliseconds the Rust
    /// projection hands over: 2026-01-15T10:30:00Z and 2029-01-15T10:30:00Z.
    private static let issuedAt: Int64 = 1_768_473_000_000
    private static let expiresAt: Int64 = 1_863_167_400_000

    /// Eight hyphenated groups of four from the key alphabet (no I, L, O or 0),
    /// in the normalized form the Rust crate stores and hands over.
    private static let key = "AB12-CD34-EF56-GH78-JK9M-NP2Q-RS3T-6UJV"
    private static let masked = "···· ···· ···· ···· ···· ···· ···· 6UJV"

    private func view(
        _ status: LicenseStatus, issued: Int64?, expires: Int64?,
        key: String? = LicenseCopyTests.key
    ) -> LicenseView {
        LicenseView(
            status: status, issuedAtMillis: issued, expiresAtMillis: expires,
            key: status == .unlicensed ? nil : key)
    }

    @Test("a licensed card names the purchase date and the expiry")
    func licensedCard() {
        let card = licenseCardModel(
            view(.licensed, issued: Self.issuedAt, expires: Self.expiresAt),
            localization)

        #expect(card.status == .licensed)
        // Licensed is the state with no badge: the coin in the well says it.
        #expect(card.badge == nil)
        #expect(card.since?.contains("2026") == true)
        // The full date, never a bare year (decision D3).
        #expect(card.since != "2026")
        #expect(card.term.contains("2029"))
        #expect(card.maskedKey == Self.masked)
        // A year is a date field, not a number: "2,026" would be a grouped number.
        #expect(!(card.since ?? "").contains("2,026"))
    }

    /// A perpetual product has no expiry, and the term must drop the date
    /// rather than invent one.
    @Test("a perpetual license reads as Perpetual")
    func perpetualCard() {
        let card = licenseCardModel(
            view(.licensed, issued: Self.issuedAt, expires: nil), localization)

        #expect(card.term == localization.localizedText("license.card.termPerpetual"))
        #expect(card.term != "license.card.termPerpetual")
        #expect(!card.term.contains("2029"))
        #expect(card.since?.contains("2026") == true)
    }

    /// An expired license still says when it was bought: it is kept on the
    /// device, and the purchase still happened.
    @Test("an expired card is badged and its term carries the expiry date")
    func expiredCard() {
        let card = licenseCardModel(
            view(.expired, issued: Self.issuedAt, expires: Self.expiresAt),
            localization)

        #expect(card.status == .expired)
        #expect(card.badge == localization.localizedText("license.statusExpired"))
        #expect(card.since?.contains("2026") == true)
        #expect(card.term.contains("2029"))
        #expect(card.maskedKey == Self.masked)
    }

    /// The v1 reality on this surface (decision D2): the since row is present
    /// and blank. No dateless variant, no placeholder, no fetch time — and the
    /// state is still unmistakably Licensed.
    @Test("a license with no purchase date leaves the since row blank")
    func undatedLicensedCard() {
        let card = licenseCardModel(view(.licensed, issued: nil, expires: nil), localization)

        #expect(card.status == .licensed)
        #expect(card.since == nil)
        #expect(card.badge == nil)
        #expect(card.term == localization.localizedText("license.card.termPerpetual"))
        #expect(card.maskedKey == Self.masked)
        // Nothing was substituted for the missing date — not this year, not any.
        let thisYear = localization.localizedYear(Date().timeIntervalSince1970 * 1000)
        #expect(!card.term.contains(thisYear))
    }

    @Test("no stored license reads as Unlicensed")
    func unlicensedCard() {
        let card = licenseCardModel(view(.unlicensed, issued: nil, expires: nil), localization)

        #expect(card.status == .unlicensed)
        #expect(card.badge == localization.localizedText("license.unlicensed"))
        // The catalog answered — a missing entry renders as its own path.
        #expect(card.badge != "license.unlicensed")
        #expect(card.since == nil)
        #expect(card.term == "")
        #expect(card.maskedKey == nil)
    }

    /// Defensive: an Expired state can only come from a v2 activation whose
    /// expiry passed, so it always has both dates. One arriving without them
    /// must fall back to the whole Unlicensed card.
    @Test("an expired state without its dates falls back to Unlicensed")
    func expiredWithoutDates() {
        let unlicensed = licenseCardModel(
            view(.unlicensed, issued: nil, expires: nil), localization)

        for card in [
            licenseCardModel(view(.expired, issued: Self.issuedAt, expires: nil), localization),
            licenseCardModel(view(.expired, issued: nil, expires: Self.expiresAt), localization),
        ] {
            #expect(card == unlicensed)
        }
    }

    /// The whole point of the mask: seven groups of dots and the real last
    /// group, so a support conversation can name a key without the screen
    /// showing it.
    @Test("the masked key shows only the last group")
    func maskedKey() {
        let masked =
            licenseCardModel(
                view(.licensed, issued: Self.issuedAt, expires: Self.expiresAt), localization
            ).maskedKey ?? ""

        #expect(masked == Self.masked)
        #expect(masked.hasSuffix("6UJV"))
        #expect(!masked.contains("AB12"))
        #expect(!masked.contains("RS3T"))
        // The dots stand in for the key's own groups, not for its separators.
        #expect(masked.split(separator: " ").count == 8)
    }
}
