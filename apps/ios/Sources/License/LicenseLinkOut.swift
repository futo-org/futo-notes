import Foundation

/// The store-posture flag from docs/spec/license.md § Store posture.
///
/// `true` at launch: the app ships the full surface worldwide — key field, deep
/// link, and the Buy link out to the system browser. If a store objects, the
/// answer is this flag, not a redesign: `false` hides **Buy, Renew and
/// Lost-your-key** and keeps the key field and the deep link (the
/// consumption-only shape Apple and Google both permit).
///
/// It is a build-time constant, not a preference: a user must never be able to
/// flip it, and a review build must be able to differ from a direct build. Set
/// `LICENSE_LINK_OUT_DISABLED` in `SWIFT_ACTIVE_COMPILATION_CONDITIONS` for a
/// build that must not link out; which controls each value produces is decided
/// in Rust (`licenseRowActions`) so iOS and Android cannot drift on it.
enum LicenseLinkOut {
    #if LICENSE_LINK_OUT_DISABLED
        static let isEnabled = false
    #else
        static let isEnabled = true
    #endif
}
