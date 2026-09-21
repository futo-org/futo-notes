use std::collections::{HashMap, HashSet};

use crate::checkpoint::ObjectState;

pub type Progress = dyn Fn(SyncProgress) + Send + Sync;
pub type PreWrite = dyn Fn(&str) + Send + Sync;

#[derive(Debug, Clone)]
pub struct ConnectInfo {
    pub user_id: String,
    pub collection_id: String,
    pub token: String,
    pub auth_mode: String,
}

#[derive(Debug, Clone, Copy)]
pub struct SyncProgress {
    pub phase: &'static str,
    pub current: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Upload,
    Delete,
    Checkpoint,
    Download,
    Decrypt,
    Rejected,
    /// The server's change arrived intact and applying it to the vault failed.
    /// A write (no permission, a read-only mount, a full disk, a symlink or a
    /// plain file standing where a folder belongs, a local edit that landed
    /// mid-pull) or a remote deletion that could not be carried out locally.
    /// Kept apart from [`Self::Download`] because github#44 spent an entire
    /// issue auditing a healthy server and a healthy nginx: the engine produced
    /// the real reason and the caller refiled it as a download fault.
    LocalApply,
    /// The vault folder itself is not there. One condition that explains every
    /// note in the cycle, so it is reported once, by path, with the way out —
    /// not as one bullet per note.
    VaultMissing,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Delete => "delete",
            Self::Checkpoint => "checkpoint",
            Self::Download => "download",
            Self::Decrypt => "decrypt",
            Self::Rejected => "rejected",
            Self::LocalApply => "local_apply",
            Self::VaultMissing => "vault_missing",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SyncFailure {
    pub filename: String,
    pub kind: FailureKind,
    pub status_code: Option<u16>,
    /// The engine's own error text, for the instance journal only — never the
    /// user-facing string, and deliberately NOT projected into either shell
    /// contract (see `every_failure_field_is_either_projected_or_deliberately_internal`).
    /// `HttpError` keeps a full `source()` chain precisely so a failure can be
    /// told apart after the fact (see `server/mod.rs` `transport_error`), and
    /// every per-item failure used to drop it here — so the one channel built to
    /// answer "why is that note not on this device" was silent for the two
    /// causes it was most needed for (github#44).
    ///
    /// `pub` only because the shells' contract tests construct failures; treat
    /// it as engine-internal and route it to the journal, not to a user.
    pub detail: Option<String>,
}

pub(super) fn record_checkpoint_failure(summary: &mut SyncSummary) {
    if summary
        .failures
        .iter()
        .any(|failure| failure.kind == FailureKind::Checkpoint)
    {
        return;
    }
    summary.failures.push(SyncFailure {
        filename: String::new(),
        kind: FailureKind::Checkpoint,
        status_code: None,
        detail: None,
    });
}

#[derive(Debug, Clone)]
pub struct RenamePair {
    pub from_id: String,
    pub to_id: String,
}

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
    /// Diagnostics for the instance journal, not part of any shell contract —
    /// the Tauri and UniFFI projections build their own summaries field by
    /// field and never see this.
    pub(crate) decisions: Vec<ReconcileDecision>,
}

impl SyncSummary {
    /// Notes one per-file decision for the journal. Observation only — callers
    /// must record what they already decided, never decide from this.
    pub(super) fn decide(
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
    pub(super) fn decide_with(
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

#[derive(Debug, thiserror::Error)]
pub enum SyncErrorKind {
    #[error("{0}")]
    Http(String),
    #[error("{0}")]
    Auth(String),
    #[error("{0}")]
    Crypto(String),
    #[error("{0}")]
    Io(String),
    #[error("collection-gone: {0}")]
    CollectionGone(String),
    /// The vault folder is not there. Carries the same sentence as the
    /// per-item [`FailureKind::VaultMissing`] clause so a user who hits this
    /// before the cycle starts and one who hits it mid-cycle read the same
    /// thing, and so the shells render it without knowing the wording.
    #[error("Can't find your vault folder at {0}. Please reconfigure in settings.")]
    VaultMissing(String),
    #[error("not connected")]
    NotConnected,
}

impl SyncErrorKind {
    pub fn message(&self) -> String {
        self.to_string()
    }
}

impl From<SyncErrorKind> for String {
    fn from(error: SyncErrorKind) -> Self {
        error.to_string()
    }
}

pub(super) fn note_id(name: &str) -> String {
    name.strip_suffix(".md").unwrap_or(name).to_owned()
}

fn unique_rename_target<'a>(
    hash: &str,
    removed: &[(&String, &ObjectState)],
    added: &'a [(&String, &ObjectState)],
) -> Option<&'a str> {
    if removed
        .iter()
        .filter(|(_, entry)| entry.hash.as_deref() == Some(hash))
        .count()
        != 1
    {
        return None;
    }
    let mut candidates = added
        .iter()
        .filter(|(_, entry)| entry.hash.as_deref() == Some(hash));
    let (name, _) = *candidates.next()?;
    candidates.next().is_none().then_some(name.as_str())
}

pub(super) fn derive_renames(
    before: &HashMap<String, ObjectState>,
    after: &HashMap<String, ObjectState>,
) -> Vec<RenamePair> {
    let removed: Vec<_> = before
        .iter()
        .filter(|(name, _)| !after.contains_key(*name))
        .collect();
    let added: Vec<_> = after
        .iter()
        .filter(|(name, _)| !before.contains_key(*name))
        .collect();
    let mut renames = Vec::new();
    for (old_name, old) in &removed {
        let Some(hash) = old.hash.as_ref() else {
            continue;
        };
        if let Some(new_name) = unique_rename_target(hash, &removed, &added) {
            renames.push(RenamePair {
                from_id: note_id(old_name),
                to_id: note_id(new_name),
            });
        }
    }
    renames
}

fn append_unique_renames(target: &mut Vec<RenamePair>, source: Vec<RenamePair>) {
    for rename in source {
        if !target
            .iter()
            .any(|existing| existing.from_id == rename.from_id && existing.to_id == rename.to_id)
        {
            target.push(rename);
        }
    }
}

pub(super) fn append_derived_renames(
    summary: &mut SyncSummary,
    before: &HashMap<String, ObjectState>,
    after: &HashMap<String, ObjectState>,
) {
    append_unique_renames(&mut summary.renamed, derive_renames(before, after));
}

fn append_unique(target: &mut Vec<String>, source: Vec<String>) {
    for item in source {
        if !target.contains(&item) {
            target.push(item);
        }
    }
}

fn remove_rename_ghost_ids(summary: &mut SyncSummary) {
    let renamed_from: HashSet<_> = summary
        .renamed
        .iter()
        .map(|rename| rename.from_id.as_str())
        .collect();
    // Only the from-side of a rename is a ghost: every relocation records its
    // "delete at the old name" byproduct against the source id and describes
    // the move itself with the rename pair. Nothing records a byproduct
    // against the TARGET side, so an id recorded there — an update OR a
    // deletion — is always a real, subsequent event: a same-cycle peer edit to
    // a collision-relocated note (which the shell that followed the rename must
    // reload, or its next save overwrites the peer edit) or a same-cycle
    // tombstone of it (which must close the followed editor). Stripping the
    // target side erased both. Strip the from-side ghost only.
    summary
        .deleted_ids
        .retain(|id| !renamed_from.contains(id.as_str()));
    summary
        .peer_deleted_ids
        .retain(|id| !renamed_from.contains(id.as_str()));
}

pub(super) fn combine(mut push: SyncSummary, pull: SyncSummary) -> SyncSummary {
    push.uploaded += pull.uploaded;
    push.downloaded += pull.downloaded;
    push.deleted += pull.deleted;
    push.conflicts += pull.conflicts;
    push.local_writes_applied += pull.local_writes_applied;
    for failure in pull.failures {
        if failure.kind != FailureKind::Checkpoint
            || !push
                .failures
                .iter()
                .any(|existing| existing.kind == FailureKind::Checkpoint)
        {
            push.failures.push(failure);
        }
    }
    append_unique(&mut push.updated_ids, pull.updated_ids);
    append_unique(&mut push.deleted_ids, pull.deleted_ids);
    append_unique(&mut push.peer_updated_ids, pull.peer_updated_ids);
    append_unique(&mut push.peer_deleted_ids, pull.peer_deleted_ids);
    append_unique_renames(&mut push.renamed, pull.renamed);
    // Concatenated, not deduped: the cycle runs push before pull, so appending
    // keeps the decisions in the order they were actually taken.
    push.decisions.extend(pull.decisions);
    remove_rename_ghost_ids(&mut push);
    push
}

#[cfg(test)]
mod summary_shape_tests {
    use super::*;

    /// The tripwire for [`SyncSummary`]'s shape. The two shell projections
    /// (`futo_notes_ffi::sync::contract` and the desktop
    /// `sync::frontend_contract`) each assert losslessness by destructuring an
    /// engine summary, but neither can name `decisions` — it is `pub(crate)`,
    /// so both must end their patterns with `..`, and a new field would slip
    /// past them silently. That is the failure this crate has to catch
    /// instead: the native summary carried only counters for eight months
    /// precisely because nothing forced a new field to be projected.
    ///
    /// Adding a field to `SyncSummary` breaks this pattern. When it does,
    /// decide whether the field belongs in the shell contracts and update
    /// BOTH twins — or, for engine-internal diagnostics like `decisions`,
    /// list it below as deliberately not projected and say why.
    #[test]
    fn every_summary_field_is_either_projected_or_deliberately_internal() {
        let SyncSummary {
            // Projected to both shell families.
            uploaded: _,
            downloaded: _,
            deleted: _,
            conflicts: _,
            local_writes_applied: _,
            failures: _,
            updated_ids: _,
            deleted_ids: _,
            peer_updated_ids: _,
            peer_deleted_ids: _,
            renamed: _,
            // Deliberately NOT projected: instance-journal diagnostics. The
            // shells build their summaries field by field and never see this.
            decisions: _,
        } = SyncSummary::default();
    }
}
