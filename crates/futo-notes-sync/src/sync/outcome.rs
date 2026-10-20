use std::collections::{HashMap, HashSet};

use crate::checkpoint::ObjectState;

mod decisions;
mod failure;
mod summary;

pub(crate) use decisions::{decision, ReconcileDecision, SyncPhase};
use failure::derive_write_refusal;
pub use failure::{FailureKind, SyncFailure, WriteRefusal};
pub use summary::SyncSummary;

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
    // Last, so it sees every failure the cycle recorded on either side. This is
    // the ONE place the field is written: `run_cycle` assembles every summary a
    // shell ever sees through here, so a refusal cannot reach one shell and
    // miss another.
    push.write_refusal = derive_write_refusal(&push.failures);
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
            write_refusal: _,
            // Deliberately NOT projected: instance-journal diagnostics. The
            // shells build their summaries field by field and never see this.
            decisions: _,
        } = SyncSummary::default();
    }
}

#[cfg(test)]
mod write_refusal_tests {
    use super::*;

    fn failure(kind: FailureKind, status: u16) -> SyncFailure {
        SyncFailure {
            filename: "note.md".to_owned(),
            kind,
            status_code: Some(status),
            detail: None,
        }
    }

    fn cycle(failures: Vec<SyncFailure>) -> SyncSummary {
        let mut push = SyncSummary::default();
        push.failures = failures;
        combine(push, SyncSummary::default())
    }

    #[test]
    fn a_clean_cycle_refuses_nothing() {
        assert_eq!(cycle(Vec::new()).write_refusal, None);
    }

    #[test]
    fn a_402_on_a_write_is_a_lapsed_subscription() {
        assert_eq!(
            cycle(vec![failure(FailureKind::Upload, 402)]).write_refusal,
            Some(WriteRefusal::SubscriptionRequired)
        );
        // A delete is a write too: an account that may not write may not
        // remove either, and the banner is the same one.
        assert_eq!(
            cycle(vec![failure(FailureKind::Delete, 402)]).write_refusal,
            Some(WriteRefusal::SubscriptionRequired)
        );
    }

    #[test]
    fn a_507_on_a_write_is_a_full_vault() {
        assert_eq!(
            cycle(vec![failure(FailureKind::Upload, 507)]).write_refusal,
            Some(WriteRefusal::QuotaExceeded)
        );
    }

    /// THE precedence, and the reason this lives in one place: a lapsed
    /// subscription refuses the write whatever the quota says, so "buy more
    /// storage" would be the wrong instruction. Both orderings, because a
    /// cycle does not promise which failure it recorded first.
    #[test]
    fn a_lapsed_subscription_wins_over_a_full_vault_in_the_same_cycle() {
        assert_eq!(
            cycle(vec![
                failure(FailureKind::Upload, 507),
                failure(FailureKind::Upload, 402),
            ])
            .write_refusal,
            Some(WriteRefusal::SubscriptionRequired)
        );
        assert_eq!(
            cycle(vec![
                failure(FailureKind::Upload, 402),
                failure(FailureKind::Upload, 507),
            ])
            .write_refusal,
            Some(WriteRefusal::SubscriptionRequired)
        );
    }

    /// Reads are never gated. A 402 that somehow arrives on the pull half is
    /// not the server refusing a write and must not raise "Sync paused".
    #[test]
    fn only_the_write_half_can_be_refused() {
        assert_eq!(
            cycle(vec![
                failure(FailureKind::Download, 402),
                failure(FailureKind::Decrypt, 507),
                failure(FailureKind::LocalApply, 402),
            ])
            .write_refusal,
            None
        );
    }

    #[test]
    fn an_ordinary_server_fault_is_not_a_refusal() {
        assert_eq!(
            cycle(vec![
                failure(FailureKind::Upload, 500),
                failure(FailureKind::Upload, 502),
                SyncFailure {
                    filename: "note.md".to_owned(),
                    kind: FailureKind::Upload,
                    status_code: None,
                    detail: None,
                },
            ])
            .write_refusal,
            None
        );
    }

    /// Never a latch. The field is rebuilt from the failures of the cycle that
    /// produced it, so the first cycle that is not refused clears the banner
    /// without anything having to remember to reset it.
    #[test]
    fn the_next_clean_cycle_clears_it() {
        let refused = cycle(vec![failure(FailureKind::Upload, 402)]);
        assert_eq!(
            refused.write_refusal,
            Some(WriteRefusal::SubscriptionRequired)
        );
        assert_eq!(cycle(Vec::new()).write_refusal, None);
    }

    /// The push half carries the refusal into the combined cycle even when the
    /// pull half succeeded — which is the whole shape of a lapsed account:
    /// reads arrive, writes do not.
    #[test]
    fn a_refused_push_survives_a_clean_pull() {
        let mut push = SyncSummary::default();
        push.failures = vec![failure(FailureKind::Upload, 402)];
        let mut pull = SyncSummary::default();
        pull.downloaded = 3;
        let combined = combine(push, pull);
        assert_eq!(combined.downloaded, 3);
        assert_eq!(
            combined.write_refusal,
            Some(WriteRefusal::SubscriptionRequired)
        );
    }

    #[test]
    fn the_wire_identifiers_are_stable() {
        assert_eq!(
            WriteRefusal::SubscriptionRequired.as_str(),
            "subscriptionRequired"
        );
        assert_eq!(WriteRefusal::QuotaExceeded.as_str(), "quotaExceeded");
    }
}
