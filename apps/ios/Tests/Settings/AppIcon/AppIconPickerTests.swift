import Testing

@testable import FutoNotesNative

/// What the picker draws is a pure function of the license's `includes` and
/// Rust's `licenseEvidenceRowActions`; the inputs here come from the real FFI
/// so the shape is tested against the answers the app actually gets.
@Suite("App icon picker shape")
struct AppIconPickerTests {
    struct Row: Sendable, CustomTestStringConvertible {
        let name: String
        let status: LicenseStatus?  // nil: the license has not been read yet
        let linkOut: Bool
        var selected: AppIcon = .darkStandard
        var available = true
        /// The App Store product loaded / this account owns it (ADR-0009).
        var offered = false
        var owned = false
        let coined: Set<AppIcon>
        let footnote: Bool
        let sheet: AppIconPickerShape.Sheet?
        var resolved = true
        var footnoteKey = "settings.appIcon.license.footnote"
        var appStoreButton = false

        var testDescription: String { name }
    }

    static let all = Set(AppIcon.allCases)

    static let rows = [
        Row(
            name: "unlicensed: coins but the current, footnote, a Buy sheet",
            status: .unlicensed, linkOut: true, coined: all.subtracting([.darkStandard]),
            footnote: true, sheet: .linkOut(primary: .buy)),
        Row(
            name: "expired asks the same, with Renew where Buy would be",
            status: .expired, linkOut: true, coined: all.subtracting([.darkStandard]),
            footnote: true, sheet: .linkOut(primary: .renew)),
        Row(
            name: "key-only build: the key-only sheet, still coins and the footnote",
            status: .unlicensed, linkOut: false, coined: all.subtracting([.darkStandard]),
            footnote: true, sheet: .keyOnly, footnoteKey: "settings.appIcon.license.footnoteKeyOnly"
        ),
        Row(
            name: "licensed: coin on every tile but Standard, no footnote, nothing to ask",
            status: .licensed, linkOut: true, selected: .website,
            coined: all.subtracting([.lightStandard]), footnote: false, sheet: nil),
        Row(
            name: "unknown (still loading): no coins, no footnote, no ask, inert",
            status: nil, linkOut: true, coined: [], footnote: false, sheet: nil, resolved: false),
        Row(
            name: "an OS that cannot change icons gets no ask at all",
            status: .unlicensed, linkOut: true, available: false, coined: [], footnote: false,
            sheet: nil),
        Row(
            name: "App Store offered in the US: the Buy sheet gains Buy in the App Store",
            status: .unlicensed, linkOut: true, offered: true,
            coined: all.subtracting([.darkStandard]), footnote: true,
            sheet: .linkOut(primary: .buy), appStoreButton: true),
        Row(
            name: "App Store offered elsewhere: the key-only sheet gains it too",
            status: .unlicensed, linkOut: false, offered: true,
            coined: all.subtracting([.darkStandard]), footnote: true, sheet: .keyOnly,
            footnoteKey: "settings.appIcon.license.footnoteKeyOnly", appStoreButton: true),
        Row(
            name: "App Store purchase owned: the picker reads exactly as Licensed",
            status: .expired, linkOut: false, selected: .website, offered: true, owned: true,
            coined: all.subtracting([.lightStandard]), footnote: false, sheet: nil),
    ]

    @Test("the shape follows the license", arguments: rows)
    func shape(_ row: Row) {
        let shape = appIconPickerShape(
            selected: row.selected,
            includes: evidence(row).map { Set(licenseEvidenceIncludes(evidence: $0)) },
            rowActions: evidence(row).map {
                licenseEvidenceRowActions(
                    evidence: $0, surface: row.linkOut ? .linkOut : .keyOnly,
                    appStoreOffered: row.offered)
            } ?? [],
            available: row.available)

        #expect(shape.coined == row.coined)
        #expect(shape.footnote == row.footnote)
        #expect(shape.sheet == row.sheet)
        #expect(shape.resolved == row.resolved)
        #expect(shape.footnoteKey == row.footnoteKey)
        #expect(shape.appStore == row.appStoreButton)
        #expect(
            AppIcon.allCases.allSatisfy {
                shape.asks($0) == (row.sheet != nil && row.coined.contains($0))
            })
    }

    private func evidence(_ row: Row) -> LicenseEvidence? {
        row.status.map { LicenseEvidence(key: $0, appStore: row.owned) }
    }
}
