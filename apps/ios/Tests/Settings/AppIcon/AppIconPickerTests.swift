import Testing

@testable import FutoNotesNative

/// What the picker draws is a pure function of the license's `includes` and
/// Rust's `licenseRowActions`; the inputs here come from the real FFI so the
/// shape is tested against the answers the app actually gets.
@Suite("App icon picker shape")
struct AppIconPickerTests {
    private func shape(
        _ status: LicenseStatus, linkOut: Bool, selected: AppIcon = .darkStandard
    ) -> AppIconPickerShape {
        appIconPickerShape(
            selected: selected,
            includes: Set(licenseIncludes(status: status)),
            rowActions: licenseRowActions(status: status, linkOut: linkOut))
    }

    @Test("unlicensed: a coin on every tile but the current one, the footnote, a Buy sheet")
    func unlicensedLinkOut() {
        let shape = shape(.unlicensed, linkOut: true)

        #expect(shape.coined == Set(AppIcon.allCases).subtracting([.darkStandard]))
        #expect(shape.footnote)
        #expect(shape.sheet == .linkOut(primary: .buy))
        #expect(!shape.asks(.darkStandard))
        #expect(shape.asks(.lightStandard))
    }

    @Test("expired asks the same, with Renew where Buy would be")
    func expiredRenews() {
        let shape = shape(.expired, linkOut: true)

        #expect(shape.footnote)
        #expect(shape.sheet == .linkOut(primary: .renew))
    }

    @Test("a key-only build gets the key-only sheet, still with coins and the footnote")
    func keyOnly() {
        let shape = shape(.unlicensed, linkOut: false)

        #expect(shape.coined.count == AppIcon.allCases.count - 1)
        #expect(shape.footnote)
        #expect(shape.sheet == .keyOnly)
    }

    @Test("licensed: the coin stays on every tile but Standard, no footnote, nothing to ask")
    func licensed() {
        for selected in [AppIcon.lightStandard, .website] {
            let shape = shape(.licensed, linkOut: true, selected: selected)

            #expect(shape.coined == Set(AppIcon.allCases).subtracting([.lightStandard]))
            #expect(!shape.footnote)
            #expect(shape.sheet == nil)
            #expect(AppIcon.allCases.allSatisfy { !shape.asks($0) })
        }
    }

    @Test("an OS that cannot change icons gets no ask at all")
    func unavailable() {
        let shape = appIconPickerShape(
            selected: .lightStandard, includes: [],
            rowActions: licenseRowActions(status: .unlicensed, linkOut: true), available: false)

        #expect(shape == AppIconPickerShape(coined: [], footnote: false, sheet: nil))
    }
}
