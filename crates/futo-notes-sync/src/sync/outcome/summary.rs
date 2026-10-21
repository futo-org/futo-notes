//! The counters, ids and failures one cycle reports to the shells.

use super::FailureKind;
use super::{ReconcileDecision, RenamePair, SyncFailure, SyncPhase, WriteRefusal};

#[derive(Debug, Default, Clone)]
pub struct SyncSummary {
    pub uploaded: u32,
    pub downloaded: u32,
    pub deleted: u32,
    pub conflicts: u32,
    pub local_writes_applied: u32,
    pub failures: Vec<SyncFailure>,
    pub updated_ids: Vec<String>,
    pub deleted_ids: Vec<String>,
    pub peer_updated_ids: Vec<String>,
    pub peer_deleted_ids: Vec<String>,
    pub renamed: Vec<RenamePair>,
    /// Set when the server refused this cycle's writes, and what the shells
    /// must say about it. `None` on every clean cycle, so it is never a latch:
    /// the next cycle that is not refused clears the banner by replacing this.
    /// Written only by [`combine`], from the failures the cycle recorded.
    pub write_refusal: Option<WriteRefusal>,
    /// Diagnostics for the instance journal, not part of any shell contract —
    /// the Tauri and UniFFI projections build their own summaries field by
    /// field and never see this.
    pub(crate) decisions: Vec<ReconcileDecision>,
}

impl SyncSummary {
    /// Notes one per-file decision for the journal. Observation only — callers
    /// must record what they already decided, never decide from this.
    pub(in crate::sync) fn decide(
        &mut self,
        phase: SyncPhase,
        filename: &str,
        decision: &'static str,
        reason: &'static str,
    ) {
        self.decisions.push(ReconcileDecision {
            phase,
            filename: filename.to_owned(),
            decision,
            reason,
            detail: None,
        });
    }

    /// The same, plus the one detail that makes the line actionable — the copy a
    /// park wrote, the HTTP status a failure carried, the name a rename landed on.
    pub(in crate::sync) fn decide_with(
        &mut self,
        phase: SyncPhase,
        filename: &str,
        decision: &'static str,
        reason: &'static str,
        detail: String,
    ) {
        self.decisions.push(ReconcileDecision {
            phase,
            filename: filename.to_owned(),
            decision,
            reason,
            detail: Some(detail),
        });
    }

    pub(crate) fn decisions(&self) -> &[ReconcileDecision] {
        &self.decisions
    }

    /// The most common status among a set of failures, ties keeping the
    /// first-seen code so every platform renders the same sentence.
    fn dominant_status(failures: &[&SyncFailure]) -> Option<u16> {
        let mut frequencies = Vec::<(u16, usize)>::new();
        for status in failures.iter().filter_map(|failure| failure.status_code) {
            if let Some((_, count)) = frequencies.iter_mut().find(|(code, _)| *code == status) {
                *count += 1;
            } else {
                frequencies.push((status, 1));
            }
        }
        frequencies
            .into_iter()
            .enumerate()
            .max_by_key(|(index, (_, count))| (*count, std::cmp::Reverse(*index)))
            .map(|(_, (status, _))| status)
    }

    pub fn failure_message(&self) -> Option<String> {
        let of = |kind| {
            self.failures
                .iter()
                .filter(|failure| failure.kind == kind)
                .collect::<Vec<_>>()
        };
        let count = |kind| of(kind).len();

        // The vault folder being gone explains every other failure in the
        // cycle, so it answers alone and by path. Anything else would bury the
        // one line that says what to do (github#44: the reporter read "3 notes
        // couldn't be downloaded" as a server fault and audited his server,
        // his nginx and his logs before finding the folder).
        let vault = of(FailureKind::VaultMissing);
        if let Some(failure) = vault.first() {
            return Some(format!(
                "Can't find your vault folder at {}. Please reconfigure in settings.",
                failure.filename
            ));
        }

        let mut parts = Vec::new();
        let server = of(FailureKind::Upload)
            .into_iter()
            .chain(of(FailureKind::Delete))
            .collect::<Vec<_>>();
        if !server.is_empty() {
            let noun = if server.len() == 1 {
                "change"
            } else {
                "changes"
            };
            let mut message = format!("{} {noun} couldn't reach the server", server.len());
            if let Some(status) = Self::dominant_status(&server) {
                message.push_str(&format!(" (HTTP {status})"));
            }
            parts.push(message);
        }
        for (kind, singular, plural, suffix) in [
            (
                FailureKind::Download,
                "note couldn't be downloaded",
                "notes couldn't be downloaded",
                " (will retry)",
            ),
            // The server's bytes are already in hand; only the local step
            // failed. Never the network wording — a read-only mount or a full
            // disk has nothing to do with the server — and "change" rather than
            // "note" because a remote deletion this client cannot carry out
            // locally lands here too. The retry promise is the same cursor cap
            // the download clause relies on.
            (
                FailureKind::LocalApply,
                "change couldn't be applied to your notes folder",
                "changes couldn't be applied to your notes folder",
                " (will retry)",
            ),
            (
                FailureKind::Decrypt,
                "note couldn't be decrypted",
                "notes couldn't be decrypted",
                "",
            ),
            (
                FailureKind::Rejected,
                "note had an unsupported name and was skipped",
                "notes had unsupported names and were skipped",
                "",
            ),
        ] {
            let failures = of(kind);
            if failures.is_empty() {
                continue;
            }
            let mut message = format!(
                "{} {}",
                failures.len(),
                if failures.len() == 1 {
                    singular
                } else {
                    plural
                }
            );
            // Downloads have carried a status since the batch route landed and
            // the message threw it away, so an nginx 502 and a vanished folder
            // read identically. Uploads have always named theirs.
            if let Some(status) = Self::dominant_status(&failures) {
                message.push_str(&format!(" (HTTP {status})"));
            }
            message.push_str(suffix);
            parts.push(message);
        }
        if count(FailureKind::Checkpoint) > 0 {
            parts.push("sync state couldn't be saved locally".into());
        }
        (!parts.is_empty()).then(|| parts.join("; "))
    }
}
