import Foundation

extension SyncManager {
    // ── Which session wins ──────────────────────────────────────────────
    //
    // Two decisions, both `static` and both pure, so they are pinned by the
    // shared cross-shell case-set in `tests/conformance/sync-session-mode.json`
    // rather than only by whatever a device happened to do. Kotlin carries the
    // same pair (`SyncManager.hostedConnectEntry` / `restoreBranch`).

    /// Which door opened the session this manager is currently holding.
    /// `internal` so the conformance test can name it.
    enum SessionMode {
        case selfHosted
        case hosted
    }

    /// What a hosted connect does about the session already in hand.
    enum HostedConnectEntry {
        /// The wizard re-entering on a session it already has. It fires a
        /// connect whenever it sees an unlocked vault, and a second client
        /// would leave the first one's live loop running.
        case skip
        /// The switch: end the self-hosted session, then connect hosted.
        case replaceSelfHosted
        /// An ordinary connect with nothing in the way.
        case proceed

        var fixtureName: String {
            switch self {
            case .skip: "skip"
            case .replaceSelfHosted: "replaceSelfHosted"
            case .proceed: "proceed"
            }
        }
    }

    /// Mode-aware because it did not used to be: the guard skipped on *any*
    /// live session, and a self-hosted one is not a reason to skip the connect
    /// that is meant to replace it. Completing the wizard over a live password
    /// session left a normal-looking account card reading `0 B of 10 GB used`
    /// with no cycle behind it, and the next launch went back to the old
    /// server (iOS simulator, 2026-09-16). Justin's call the same day:
    /// finishing hosted setup replaces a self-hosted session. → sync.md
    static func hostedConnectEntry(
        connected: Bool, hasClient: Bool, healing: Bool, mode: SessionMode?
    ) -> HostedConnectEntry {
        // A client that is gone cannot be holding a live loop, and a session
        // being healed is being rebuilt — neither is a session to skip for.
        if connected, hasClient, !healing, mode == .hosted { return .skip }
        // `hasClient` and not `connected`: a cycle that failed still leaves the
        // live loop running, and that loop is exactly what must not be orphaned.
        if hasClient, mode == .selfHosted { return .replaceSelfHosted }
        return .proceed
    }

    /// Which credential a cold launch reaches for.
    enum RestoreBranch {
        case hosted
        case selfHosted
        case nothing

        var fixtureName: String {
            switch self {
            case .hosted: "hosted"
            case .selfHosted: "selfHosted"
            case .nothing: "nothing"
            }
        }
    }

    /// Both inputs are local secret-store reads, so this costs no network even
    /// on a launch with none.
    ///
    /// **Holding both is a one-time migration heal that retires itself, not a
    /// change of precedence.** With no hosted vault the password still wins —
    /// that is what keeps a self-hosted device self-hosted, and it is the whole
    /// difference between this and the "just invert the precedence" option that
    /// was rejected for breaking the reverse case identically. Both shells stop
    /// offering the self-hosted fields once hosted sync is set up
    /// (`HostedSyncSections`, `model.screen != .account`), so a device can no
    /// longer arrive at both secrets by any route a person can take; the only
    /// devices that hold both are ones stranded by a build from before a hosted
    /// connect cleared the password. Taking the hosted branch there runs that
    /// clear, after which the state cannot recur — so this branch stops being
    /// reachable on its own rather than needing a flag to switch it off. Do not
    /// "simplify" it into unconditional hosted-first. Justin's call,
    /// 2026-09-16. → sync.md
    static func restoreBranch(hasStoredPassword: Bool, hasHostedVault: Bool) -> RestoreBranch {
        if hasHostedVault { return .hosted }
        if hasStoredPassword { return .selfHosted }
        return .nothing
    }
}
