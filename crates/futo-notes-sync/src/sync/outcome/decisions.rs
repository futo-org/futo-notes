//! The per-file decision record the instance journal keeps.

/// Which half of the push-first cycle reached a decision. Bootstrap counts as
/// `Pull` — it is the virgin-state pull that runs before the push.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SyncPhase {
    Push,
    Pull,
}

/// One file, what the cycle did to it, and which branch decided that. Recorded
/// only where a cycle actually acted: an unchanged file is not a decision, and
/// journaling every one of them would bury the interesting lines in a vault-
/// sized wall of no-ops.
///
/// The counters above are lossy on purpose (`conflicts` alone covers an oversize
/// skip, a delete-vs-edit, and four different parks). These are what an
/// after-the-fact investigation actually needs, and they are pure observation —
/// nothing reads them back into a sync decision.
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct ReconcileDecision {
    pub(crate) phase: SyncPhase,
    pub(crate) filename: String,
    pub(crate) decision: &'static str,
    pub(crate) reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
}

/// The decision vocabulary, named once so the recording sites and the journal's
/// roll-up counts cannot drift apart.
pub(crate) mod decision {
    pub(crate) const UPLOADED_NEW: &str = "uploaded_new";
    pub(crate) const UPLOADED_UPDATE: &str = "uploaded_update";
    pub(crate) const SKIPPED_OVERSIZE: &str = "skipped_oversize";
    pub(crate) const DELETED_REMOTE: &str = "deleted_remote";
    pub(crate) const RENAME_DETECTED: &str = "rename_detected";
    pub(crate) const DOWNLOADED: &str = "downloaded";
    pub(crate) const ADOPTED_REMOTE: &str = "adopted_remote";
    pub(crate) const MERGED: &str = "merged";
    pub(crate) const CONFLICT_COPY: &str = "conflict_copy";
    pub(crate) const PARKED_LOCAL: &str = "parked_local";
    pub(crate) const RELOCATED: &str = "relocated";
    pub(crate) const TOMBSTONE_APPLIED: &str = "tombstone_applied";
    pub(crate) const TOMBSTONE_PARKED: &str = "tombstone_parked";
    pub(crate) const FAILED: &str = "failed";
    /// Left strictly alone — not written, not uploaded, and deliberately NOT a
    /// failure. Journal-only, so the silence is still answerable after the fact.
    pub(crate) const IGNORED: &str = "ignored";
}
