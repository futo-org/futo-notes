import Foundation

/// The subscription, in words.
///
/// `state` is the payment provider's own vocabulary, carried through Rust
/// verbatim, so this is where it becomes a sentence a person reads (ADR 0003,
/// decision 8). An unrecognised state falls back to the entitlement — the one
/// field that is always meaningful — rather than showing the raw word.
///
/// A past-due account says when sync stops, because the grace period is the
/// only part of this a person can still act on. `localization` is a parameter
/// because that date is rendered relative to now.
///
/// A hand-written mirror of `src/features/sync/subscriptionState.ts`,
/// registered in `scripts/drift-registry.json`.
func subscriptionStateMessage(
    _ billing: BillingStatus,
    _ localization: Localization
) -> LocalizedMessage {
    switch billing.state {
    case "active":
        return LocalizedMessage("sync.hosted.account.state.active")
    case "trialing":
        return LocalizedMessage("sync.hosted.account.state.trialing")
    case "past_due", "unpaid":
        return pastDueMessage(billing.graceUntil, localization)
    case "canceled":
        return LocalizedMessage("sync.hosted.account.state.expired")
    case "paused":
        return LocalizedMessage("sync.hosted.account.state.paused")
    case "incomplete", "incomplete_expired":
        return LocalizedMessage("sync.hosted.account.state.incomplete")
    case "none":
        return LocalizedMessage("sync.hosted.account.state.none")
    default:
        return billing.entitled
            ? LocalizedMessage("sync.hosted.account.state.active")
            : LocalizedMessage("sync.hosted.account.state.none")
    }
}

private func pastDueMessage(
    _ graceUntil: String?,
    _ localization: Localization
) -> LocalizedMessage {
    guard let graceUntil, let millis = timestampMillis(graceUntil) else {
        return LocalizedMessage("sync.hosted.account.state.pastDueNoDate")
    }
    return LocalizedMessage(
        "sync.hosted.account.state.pastDue",
        arguments: ["when": localization.localizedRelativeTime(millis)]
    )
}

/// The server sends RFC 3339, with or without fractional seconds. Anything
/// else is treated as no date at all rather than rendered wrong.
private func timestampMillis(_ iso8601: String) -> Double? {
    for options in [
        ISO8601DateFormatter.Options([.withInternetDateTime, .withFractionalSeconds]),
        ISO8601DateFormatter.Options([.withInternetDateTime]),
    ] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = options
        if let date = formatter.date(from: iso8601) {
            return date.timeIntervalSince1970 * 1_000
        }
    }
    return nil
}
