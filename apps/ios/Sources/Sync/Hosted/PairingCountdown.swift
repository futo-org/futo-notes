import Foundation

/// How long a pairing code has left, as a person reads it.
///
/// The countdown is a **display** of the relay's own `expires_at` and nothing
/// more. What actually ends a wait is Rust: `await_pairing` rebuilds its poll
/// schedule from that same timestamp and answers `pairingExpired` when the
/// window closes. Two clocks deciding one fact is how a screen ends up saying
/// "0:00" next to a live code, or "4:59" next to a dead one — so this one only
/// ever describes.
///
/// A hand-written mirror of `src/features/sync/pairingCountdown.ts`, registered
/// in `scripts/drift-registry.json`.

/// The relay's `expires_at` is RFC 3339. Whether it carries fractional seconds
/// is the server's business, and `ISO8601DateFormatter` refuses the shape it
/// was not configured for, so both are tried rather than assumed.
private let pairingExpiryFormats: [ISO8601DateFormatter] = {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let whole = ISO8601DateFormatter()
    whole.formatOptions = [.withInternetDateTime]
    return [fractional, whole]
}()

/// Whole seconds left before `expiresAt`, never negative. An unreadable
/// timestamp reads as no time left, which is the safe way to be wrong: it shows
/// the code as spent rather than promising time it may not have.
func pairingSecondsRemaining(until expiresAt: String, now: Date = Date()) -> Int {
    guard let expiry = pairingExpiryFormats.lazy.compactMap({ $0.date(from: expiresAt) }).first
    else { return 0 }
    return max(0, Int(expiry.timeIntervalSince(now).rounded(.up)))
}

/// `m:ss`, the shape a countdown is read in.
func formatPairingCountdown(_ seconds: Int) -> String {
    let whole = max(0, seconds)
    return "\(whole / 60):\(String(format: "%02d", whole % 60))"
}
