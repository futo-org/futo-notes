import Foundation

/// What the Key row shows: the masked key until it is tapped, the stored key
/// after (decision D4).
///
/// A free function rather than a `@State`-derived expression so the reveal rule
/// is testable without hosting a SwiftUI view, and so masked and revealed can
/// never disagree about which license they came from: both start at the same
/// card model, and a card with no key has no row value in either state.
func licenseKeyRowText(_ card: LicenseCardModel, key: String?, revealed: Bool) -> String? {
    guard let masked = card.maskedKey else { return nil }
    guard revealed, let key, !key.isEmpty else { return masked }
    return key
}

/// What the plate puts on screen, before any of it is drawn.
///
/// Four independent yes/no answers, and every one of them is a decision the
/// desktop plate made in September 2026 and this shell was behind on. A free
/// function rather than four `private var`s so the decisions are testable
/// without hosting a SwiftUI view — the same reason `licenseKeyRowText` is one.
struct LicensePlateShape: Equatable {
    /// The 184pt well, and only while Licensed: an empty circle read as
    /// something that had failed to load rather than as "no license".
    let well: Bool
    /// Badge, "Client license" eyebrow, uppercase product name. Letterhead
    /// belongs to a card, and only a stored license makes this one.
    let letterhead: Bool
    /// The whole ledger — there is no "Licensed since" row and no "Term" row,
    /// because nothing records a purchase date and nothing limits a license.
    let keyRow: Bool
    /// "Pay for FUTO Notes". The ask stands in for the letterhead, never
    /// beside it.
    let headline: Bool
}

/// `nil` while the stored pair is still being read: the plate renders its frame
/// and claims nothing (M1). The App Store plate has no key to put a letterhead
/// on — not even an expired one beside the purchase — and says what it is in
/// its own title instead.
func licensePlateShape(_ card: LicenseCardModel?, linkOut: Bool, appStorePlate: Bool = false)
    -> LicensePlateShape
{
    guard let card, !appStorePlate else {
        return LicensePlateShape(well: false, letterhead: false, keyRow: false, headline: false)
    }
    let stored = card.maskedKey != nil
    return LicensePlateShape(
        well: card.status == .licensed,
        letterhead: stored,
        keyRow: stored,
        headline: !stored && linkOut)
}

/// How the card lays out Rust's row actions, in Rust's order.
///
/// Buy and Renew are filled. Where the website is offered, Buy in the App Store
/// sits beside them as a pair: same style, same size, each with a one-line
/// caption saying what it buys — App Review lets Apple forbid a web button more
/// prominent than its own, so the two get equal weight. The card around a pair
/// then holds only the choice; the text actions after it become a list of
/// their own (@justin 2026-10-19). Where the key field leads, Buy in the App
/// Store is an outlined, labeled secondary button (ADR-0009) and neighbouring
/// text buttons share a row.
enum LicenseControlGroup: Hashable {
    case filled(LicenseAction)
    case outlined(LicenseAction)
    case text([LicenseAction])
    /// Buy or Renew, then Buy in the App Store, side by side.
    case pair(LicenseAction)
    /// The text actions under a pair, as list rows.
    case rows([LicenseAction])
}

func licenseControlGroups(_ actions: [LicenseAction]) -> [LicenseControlGroup] {
    var groups: [LicenseControlGroup] = []
    for action in actions {
        switch action {
        case .buy, .renew:
            groups.append(.filled(action))
        case .buyInAppStore:
            if case .filled(let web) = groups.last {
                groups[groups.count - 1] = .pair(web)
            } else {
                groups.append(.outlined(action))
            }
        default:
            if case .text(let run) = groups.last {
                groups[groups.count - 1] = .text(run + [action])
            } else {
                groups.append(.text([action]))
            }
        }
    }
    guard groups.contains(where: { if case .pair = $0 { true } else { false } }) else {
        return groups
    }
    return groups.map { if case .text(let run) = $0 { .rows(run) } else { $0 } }
}

func licenseExplanationPath(status: LicenseStatus, linkOut: Bool) -> String {
    if status == .licensed { return "license.explanationLicensed" }
    return linkOut ? "license.explanation" : "license.keyOnlyExplanation"
}
