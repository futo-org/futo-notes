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

    private func view(_ status: LicenseStatus, issued: Int64?, expires: Int64?) -> LicenseView {
        LicenseView(status: status, issuedAtMillis: issued, expiresAtMillis: expires)
    }

    @Test("a licensed row names the supporter year and the expiry date")
    func licensedRow() {
        let text = licenseRowText(
            view(.licensed, issued: Self.issuedAt, expires: Self.expiresAt),
            localization)

        #expect(text.contains("2026"))
        #expect(text.contains("2029"))
        // A year is a date field, not a number: "2,026" would be a grouped number.
        #expect(!text.contains("2,026"))
    }

    /// A perpetual product has no expiry, and the row must drop the clause
    /// rather than invent a date.
    @Test("a perpetual license omits the expiry entirely")
    func perpetualRow() {
        let text = licenseRowText(
            view(.licensed, issued: Self.issuedAt, expires: nil), localization)

        #expect(text.contains("2026"))
        #expect(!text.contains("2029"))
        #expect(text != licenseRowText(view(.unlicensed, issued: nil, expires: nil), localization))
    }

    /// An expired license still says "Supporter since": it is kept on the
    /// device, and the purchase still happened.
    @Test("an expired row keeps the supporter year")
    func expiredRow() {
        let text = licenseRowText(
            view(.expired, issued: Self.issuedAt, expires: Self.expiresAt),
            localization)

        #expect(text.contains("2026"))
        #expect(text.contains("2029"))
    }

    /// The v1 reversal on this surface: still unmistakably the licensed state,
    /// with the "Supporter since" clause simply gone. No yearless variant, no
    /// placeholder year, and emphatically not the Unlicensed copy.
    @Test("a license with no purchase year drops the since-clause and still reads as licensed")
    func undatedLicensedRow() {
        let text = licenseRowText(view(.licensed, issued: nil, expires: nil), localization)

        #expect(text == localization.localizedText("license.licensedUndated"))
        #expect(text != "license.licensedUndated")
        #expect(text != licenseRowText(view(.unlicensed, issued: nil, expires: nil), localization))
        #expect(!text.contains("Supporter"))
        #expect(!text.contains("Valid until"))
        // Nothing was substituted for the missing year — not this year, not any.
        let thisYear = localization.localizedYear(Date().timeIntervalSince1970 * 1000)
        #expect(!text.contains(thisYear))
    }

    @Test("no stored license reads as Unlicensed")
    func unlicensedRow() {
        let text = licenseRowText(view(.unlicensed, issued: nil, expires: nil), localization)

        #expect(text == localization.localizedText("license.unlicensed"))
        // The catalog answered — a missing entry renders as its own path.
        #expect(text != "license.unlicensed")
    }
}
