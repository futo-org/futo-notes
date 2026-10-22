import Foundation

/// What the picker puts on screen, before any of it is drawn.
///
/// A pure function of the license's `includes` and Rust's `licenseRowActions`,
/// so the rendering is testable without hosting a view and no storefront logic
/// lives here: whether the ask sheet is link-out or key-only is only "does the
/// row-action list contain Buy or Renew" (docs/spec/settings.md § Native app
/// icons).
struct AppIconPickerShape: Equatable {
    enum Sheet: Equatable {
        /// Buy (or Renew when Expired) is the filled button.
        case linkOut(primary: LicenseAction)
        /// Key-only builds: "I already paid" is the filled button, nothing else.
        case keyOnly
    }

    /// Tiles wearing the coin. Never dimmed or disabled.
    let coined: Set<AppIcon>
    /// The one footnote under the grid — only while the license does not include icons.
    let footnote: Bool
    /// What tapping a coined tile opens; `nil` once the license includes icons.
    let sheet: Sheet?
    /// False while the license is still being read: unknown is neither
    /// licensed nor unlicensed, so no ask is drawn and a tap does nothing.
    var resolved = true
    /// The ask also offers Buy in the App Store (iOS, ADR-0009): Rust put it in
    /// the row actions, so the product loaded and nothing includes icons yet.
    var appStore = false

    /// The footnote's catalog key. Key-only builds keep "included with a license":
    /// "unlocks" is for link-out builds only (App Store 3.1.1, ADR-0006 D5).
    var footnoteKey: String {
        sheet == .keyOnly
            ? "settings.appIcon.license.footnoteKeyOnly" : "settings.appIcon.license.footnote"
    }

    /// Where a tap on `icon` goes: the ask sheet, or the icon change.
    func asks(_ icon: AppIcon) -> Bool { sheet != nil && coined.contains(icon) }
}

func appIconPickerShape(
    selected: AppIcon,
    includes: Set<LicenseInclusion>?,
    rowActions: [LicenseAction],
    available: Bool = true
) -> AppIconPickerShape {
    // An OS that cannot change icons shows only "unavailable": no ask to make.
    guard available else { return AppIconPickerShape(coined: [], footnote: false, sheet: nil) }
    guard let includes else {
        return AppIconPickerShape(coined: [], footnote: false, sheet: nil, resolved: false)
    }
    let licenseIcons = Set(AppIcon.allCases).subtracting(AppIcon.everyInstallHas)
    if includes.contains(.appIcon) {
        // D13: the coin stays on every icon the license includes, so the
        // picker still shows which ones came with it.
        return AppIconPickerShape(coined: licenseIcons, footnote: false, sheet: nil)
    }
    let primary = rowActions.first { $0 == .buy || $0 == .renew }
    return AppIconPickerShape(
        coined: licenseIcons.subtracting([selected]),
        footnote: true,
        sheet: primary.map { .linkOut(primary: $0) } ?? .keyOnly,
        appStore: rowActions.contains(.buyInAppStore))
}
