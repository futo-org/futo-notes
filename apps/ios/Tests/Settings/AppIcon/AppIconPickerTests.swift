import Testing

@testable import FutoNotesNative

/// What the picker draws is a pure function of the license's `includes` and
/// Rust's `licenseRowActions`; the inputs here come from the real FFI so the
/// shape is tested against the answers the app actually gets.
@Suite("App icon picker shape")
struct AppIconPickerTests {
    struct Row: Sendable, CustomTestStringConvertible {
        let name: String
        let status: LicenseStatus?  // nil: the license has not been read yet
        let linkOut: Bool
        var selected: AppIcon = .darkStandard
        var available = true
        let coined: Set<AppIcon>
        let footnote: Bool
        let sheet: AppIconPickerShape.Sheet?
        var resolved = true
        var footnoteKey = "settings.appIcon.license.footnote"

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
            footnote: true, sheet: .keyOnly, footnoteKey: "settings.appIcon.license.footnoteKeyOnly"),
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
    ]

    @Test("the shape follows the license", arguments: rows)
    func shape(_ row: Row) {
        let shape = appIconPickerShape(
            selected: row.selected,
            includes: row.status.map { Set(licenseIncludes(status: $0)) },
            rowActions: row.status.map { licenseRowActions(status: $0, linkOut: row.linkOut) } ?? [],
            available: row.available)

        #expect(shape.coined == row.coined)
        #expect(shape.footnote == row.footnote)
        #expect(shape.sheet == row.sheet)
        #expect(shape.resolved == row.resolved)
        #expect(shape.footnoteKey == row.footnoteKey)
        #expect(AppIcon.allCases.allSatisfy { shape.asks($0) == (row.sheet != nil && row.coined.contains($0)) })
    }
}
