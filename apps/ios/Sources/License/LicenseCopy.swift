import Foundation

/// How a license state reads on the License row. Pure: state in, string out.
///
/// Presentation only — which catalog entry a state selects and which timestamps
/// it formats. Whether a license *is* licensed, expired or invalid is decided
/// in Rust (`futo-notes-license`, via `licenseEvaluate`) and arrives already
/// judged, so nothing here re-derives it (AGENTS.md M6). Mirrors the desktop
/// projection's `src/features/license/licenseCopy.ts`.
func licenseRowText(_ view: LicenseView, _ localization: Localization) -> String {
    switch view.status {
    case .licensed:
        // A v1 activation carries no purchase time, and there is no yearless
        // "Supporter since" to fall back to: the clause is dropped and the row
        // is the single word "Licensed" (decision 2026-09-10, issue #161).
        guard let issuedAt = view.issuedAtMillis else {
            return localization.localizedText("license.licensedUndated")
        }
        let year = localization.localizedYear(Double(issuedAt))
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
        // Only a v2 activation whose `expires_at` has passed reaches Expired,
        // so both dates are always there. The guard is kept, and kept identical
        // to the desktop and Android copy, so the three cannot drift over an
        // impossible case.
        guard let issuedAt = view.issuedAtMillis, let expiresAt = view.expiresAtMillis else {
            return localization.localizedText("license.unlicensed")
        }
        return localization.localizedText(
            "license.expired",
            arguments: [
                "year": localization.localizedYear(Double(issuedAt)),
                "date": localization.localizedAbsoluteDate(Double(expiresAt)),
            ]
        )
    case .unlicensed:
        return localization.localizedText("license.unlicensed")
    }
}
