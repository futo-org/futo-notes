import Foundation

extension SyncManager {
    static func specificFileFailure(_ failures: [SyncFailure]) -> LocalizedMessage? {
        let oversized = failures.filter { $0.kind == "upload" && $0.statusCode == 413 }
            .map(\.filename)
        let rejected = failures.filter { $0.kind == "rejected" }.map(\.filename)
        if !oversized.isEmpty && !rejected.isEmpty {
            return LocalizedMessage(
                "sync.errors.uploadsTooLargeAndUnsupported",
                arguments: [
                    "oversized": oversized.joined(separator: ", "),
                    "unsupported": rejected.joined(separator: ", "),
                ])
        }
        if !oversized.isEmpty {
            return LocalizedMessage(
                "sync.errors.uploadsTooLarge",
                arguments: ["filenames": oversized.joined(separator: ", ")])
        }
        if !rejected.isEmpty {
            return LocalizedMessage(
                "sync.errors.unsupportedPaths",
                arguments: ["filenames": rejected.joined(separator: ", ")])
        }
        return nil
    }

    /// The short form, for the Settings row that shows sync status at a glance.
    /// `internal` so the unit tests can pin the mapping.
    static func writeRefusalHeadline(_ refusal: WriteRefusal) -> String {
        switch refusal {
        case .subscriptionRequired: "sync.hosted.banner.syncPaused.title"
        case .quotaExceeded: "sync.hosted.banner.vaultFull.title"
        }
    }

    /// The whole sentence, including what still works. Mirrors the desktop
    /// status line's wording exactly — both read the same catalog entry.
    static func writeRefusalExplanation(_ refusal: WriteRefusal) -> String {
        switch refusal {
        case .subscriptionRequired: "sync.errors.writePausedSubscription"
        case .quotaExceeded: "sync.errors.writePausedQuota"
        }
    }

    /// Validate a user-entered server URL before attempting a connection.
    /// Returns a friendly, actionable message, or nil when acceptable. Catches
    /// the common mistake of omitting the scheme — a bare host like
    /// `notes.example.com` would otherwise fail with an opaque transport error.
    /// Mirrors Android's `SyncManager.validateServerUrl`. → sync.md
    /// Must satisfy the shared case-set in `tests/conformance/server-url.json`
    /// (the source of truth for all three shells' copies of this rule).
    static func validateServerURL(_ url: String) -> String? {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Enter a server URL." }
        let lower = trimmed.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            return "Add http:// or https:// to the start of the server URL."
        }
        return nil
    }

    /// Did this cycle change the local notes tree such that the open editor
    /// must reconcile from disk? Peer downloads/deletes are obvious; the subtle
    /// case is a PUSH-side clean merge, which writes merged text to disk but
    /// reports only `uploaded` — the core surfaces those in `localWritesApplied`.
    /// Gating on `downloaded`/`deleted` alone let a stale editor keep a base
    /// whose next autosave clobbered the peer's merged-in edit (F2). A
    /// core-computed decision the shell renders — not re-derived from counts.
    /// Mirrors Android `SyncManager.wroteLocalChanges`.
    static func wroteLocalChanges(_ s: SyncSummary) -> Bool {
        s.downloaded > 0 || s.deleted > 0 || s.localWritesApplied > 0
    }
}
