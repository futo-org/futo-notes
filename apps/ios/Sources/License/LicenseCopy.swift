import Foundation

/// How a license state reads on the License row. Pure: state in, string out.
///
/// Presentation only — which catalog entry a state selects and which timestamps
/// it formats. Whether a license *is* licensed, expired or invalid is decided
/// in Rust (`futo-notes-license`, via `licenseEvaluate`) and arrives already
/// judged, so nothing here re-derives it (AGENTS.md M6). Mirrors the desktop
/// projection's `src/features/license/licenseCopy.ts`.
func licenseRowText(_ view: LicenseView, _ localization: Localization) -> String {
    guard let issuedAt = view.issuedAtMillis else {
        return localization.localizedText("license.unlicensed")
    }
    let year = localization.localizedYear(Double(issuedAt))

    switch view.status {
    case .licensed:
        // A perpetual product has no expiry, and the row must not invent one.
        guard let expiresAt = view.expiresAtMillis else {
            return localization.localizedText(
                "license.licensedPerpetual", arguments: ["year": year])
        }
        return localization.localizedText(
            "license.licensed",
            arguments: [
                "year": year, "date": localization.localizedAbsoluteDate(Double(expiresAt)),
            ]
        )
    case .expired:
        // Unreachable: `evaluate` only calls a license Expired once it has read
        // an `expires_at` and found it passed. Kept, and kept identical to the
        // desktop copy, so the two cannot drift over an impossible case.
        guard let expiresAt = view.expiresAtMillis else {
            return localization.localizedText("license.unlicensed")
        }
        return localization.localizedText(
            "license.expired",
            arguments: [
                "year": year, "date": localization.localizedAbsoluteDate(Double(expiresAt)),
            ]
        )
    case .unlicensed:
        return localization.localizedText("license.unlicensed")
    }
}
