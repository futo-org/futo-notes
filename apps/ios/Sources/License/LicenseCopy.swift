import Foundation

/// U+00B7 middle dot — one hidden character of the key.
private let licenseMaskCharacter: Character = "·"
/// The card shows the key's last group and masks everything before it.
private let licenseLastGroupLength = 4

/// What the License card renders, once per state.
///
/// Every field is a finished string for the view to place: the model decides
/// nothing about the license itself, and `status` is Rust's answer carried
/// through (the one exception is the Expired guard, which falls back to the
/// Unlicensed card rather than rendering a half-built date).
struct LicenseCardModel: Equatable {
    /// Already judged by Rust; never re-derived here.
    let status: LicenseStatus
    /// Unlicensed and Expired name themselves; Licensed is said by the coin.
    let badge: String?
    /// The purchase date, or `nil` when the activation carried none — the row
    /// is present and blank, and nothing is invented to fill it.
    let since: String?
    /// "Perpetual", "Valid until {date}" or "Expired {date}"; empty when there
    /// is no license to have a term.
    let term: String
    /// The stored key, masked to its last group. `nil` with no license.
    let maskedKey: String?
}

/// How a license state reads on the card. Pure: state in, strings out.
///
/// Presentation only — which catalog entry a state selects, which timestamps it
/// formats, and how the stored key is masked. Whether a license *is* licensed,
/// expired or invalid is decided in Rust (`futo-notes-license`, via
/// `licenseEvaluate`) and arrives already judged, so nothing here re-derives it
/// (AGENTS.md M6). Mirrors the desktop projection's
/// `src/features/license/licenseCopy.ts` and Android's `LicenseCopy.kt`.
func licenseCardModel(_ view: LicenseView, _ localization: Localization) -> LicenseCardModel {
    switch view.status {
    case .unlicensed:
        return unlicensedCard(localization)
    case .expired:
        // Only a v2 activation whose `expires_at` has passed reaches Expired,
        // so both dates are always there. The guard is kept, and kept identical
        // to the desktop and Android copy, so the three cannot drift over an
        // impossible case — and no card is ever dated "NaN".
        guard let issuedAt = view.issuedAtMillis, let expiresAt = view.expiresAtMillis else {
            return unlicensedCard(localization)
        }
        return LicenseCardModel(
            status: .expired,
            badge: localization.localizedText("license.statusExpired"),
            since: localization.localizedAbsoluteDate(Double(issuedAt)),
            term: localization.localizedText(
                "license.card.termExpired",
                arguments: ["date": localization.localizedAbsoluteDate(Double(expiresAt))]),
            maskedKey: maskedLicenseKey(view.key)
        )
    case .licensed:
        // A v1 activation carries no purchase time: `since` is nil, the row
        // renders blank, and no stand-in date is put in its place (decision
        // 2026-09-16 D2, issue #161). It is perpetual by format, not by guess.
        let term: String
        if let expiresAt = view.expiresAtMillis {
            term = localization.localizedText(
                "license.card.termValidUntil",
                arguments: ["date": localization.localizedAbsoluteDate(Double(expiresAt))])
        } else {
            term = localization.localizedText("license.card.termPerpetual")
        }
        return LicenseCardModel(
            status: .licensed,
            // Licensed wears no badge: the coin in the well is the statement.
            badge: nil,
            since: view.issuedAtMillis.map { localization.localizedAbsoluteDate(Double($0)) },
            term: term,
            maskedKey: maskedLicenseKey(view.key)
        )
    }
}

private func unlicensedCard(_ localization: Localization) -> LicenseCardModel {
    LicenseCardModel(
        status: .unlicensed,
        badge: localization.localizedText("license.unlicensed"),
        since: nil,
        term: "",
        maskedKey: nil
    )
}

/// The stored key with every character before its last group replaced by a
/// middle dot, and its hyphens left where they are:
/// `····-····-····-····-····-····-····-6UJV`.
///
/// The mask is the SAME LENGTH as the key and keeps its separators in the same
/// columns, which is what makes revealing it an in-place swap: the card renders
/// the value in a monospace face, so every dot is replaced by the character that
/// was hiding under it and nothing on the plate moves (@justin 2026-09-18). The
/// first mask was a fixed seven groups of dots joined by SPACES — 39 characters
/// whatever the key, so an org-prefixed 42-character key jumped three cells to
/// the right as it appeared, and the rows below it shifted with it. The key
/// arrives normalized (trimmed, uppercased) from the Rust crate, so it is masked
/// as it stands.
private func maskedLicenseKey(_ key: String?) -> String? {
    guard let key else { return nil }
    guard key.count > licenseLastGroupLength else { return key }
    let hidden = key.dropLast(licenseLastGroupLength).map {
        $0 == "-" ? $0 : licenseMaskCharacter
    }
    return String(hidden) + String(key.suffix(licenseLastGroupLength))
}
