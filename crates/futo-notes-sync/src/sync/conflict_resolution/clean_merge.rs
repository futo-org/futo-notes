use futo_notes_core::hash::hash_sha256;
use futo_notes_core::merge::{three_way_merge, MergeResult};

use crate::checkpoint::ObjectState;
use crate::server::{timestamp_ms, Conflict, Write};

use super::super::encrypted_note::{encrypt, object_state};
use super::super::outcome::note_id;
use super::super::push::PushContext;
use super::super::transfer::http_transport::dispatch_one_upload;
use super::super::transfer::{CandidateResult, UploadCandidate, UploadTarget};
use super::super::vault::{read_content, LocalFile};
use super::super::{decision, FailureKind, RenamePair, SyncErrorKind, SyncFailure, SyncPhase};
use super::guarded_adoption::{replace_with_source_fallback, GuardedReplacement};
use super::{create_from_content, reason};

pub(super) enum MergeAttempt {
    Applied((String, ObjectState)),
    Failed,
    NeedsConflictCopy,
}

fn merged_upload_candidate(
    file: &LocalFile,
    existing: &ObjectState,
    conflict: &Conflict,
    target: &str,
    merged: &str,
    merged_hash: &str,
    ciphertext: Vec<u8>,
) -> UploadCandidate {
    let mut current = existing.clone();
    current.version = conflict.current_version;
    UploadCandidate {
        file: LocalFile {
            name: target.to_owned(),
            mtime: file.mtime,
            size: merged.len() as u64,
        },
        target: UploadTarget::Update(current),
        content: merged.to_owned(),
        hash: merged_hash.to_owned(),
        ciphertext,
        local_was_rename: false,
    }
}

fn record_merged_replacement(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    requested_target: &str,
    replacement: GuardedReplacement,
) -> (String, bool) {
    let GuardedReplacement::Applied(settled_name) = replacement else {
        return (file.name.clone(), true);
    };
    context.summary.local_writes_applied += 1;
    context.summary.updated_ids.push(note_id(&settled_name));
    if settled_name != requested_target {
        context.summary.conflicts += 1;
    }
    if settled_name != file.name {
        context.summary.deleted_ids.push(note_id(&file.name));
        context.summary.renamed.push(RenamePair {
            from_id: note_id(&file.name),
            to_id: note_id(&settled_name),
        });
    }
    (settled_name, false)
}

/// The merged revision is on the server, but the local file moved past `local`
/// while it uploaded — the editor's next save landed. That newer text descends
/// from `local`, not from the merged revision, so it is rebased onto the merged
/// text with `local` as the ancestor. `SourceChanged` means it could not be:
/// the file is gone, the rebase conflicts, or it moved again.
fn rebase_newer_local_edit(
    context: &PushContext<'_>,
    file: &LocalFile,
    target: &str,
    local: &str,
    merged: &str,
    modified: i64,
) -> Result<GuardedReplacement, String> {
    let Ok(newer) = read_content(context.root, &file.name) else {
        return Ok(GuardedReplacement::SourceChanged);
    };
    let MergeResult::Clean(rebased) = three_way_merge(local, merged, &newer) else {
        return Ok(GuardedReplacement::SourceChanged);
    };
    replace_with_source_fallback(
        context,
        file,
        target,
        &rebased,
        &hash_sha256(&newer),
        modified,
    )
}

struct MergedWrite<'a> {
    target: String,
    local: &'a str,
    merged: &'a str,
    expected_local_hash: &'a str,
    merged_hash: String,
    existing: &'a ObjectState,
    write: Write,
}

fn apply_merged_write(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    merged_write: MergedWrite<'_>,
) -> MergeAttempt {
    let MergedWrite {
        target,
        local,
        merged,
        expected_local_hash,
        merged_hash,
        existing,
        write,
    } = merged_write;
    let modified = timestamp_ms(&write.object.updated_at);
    let mut rebased = false;
    let replacement = match replace_with_source_fallback(
        context,
        file,
        &target,
        merged,
        expected_local_hash,
        modified,
    ) {
        Ok(GuardedReplacement::SourceChanged) => {
            rebased = true;
            rebase_newer_local_edit(context, file, &target, local, merged, modified)
        }
        other => other,
    };
    let replacement = match replacement {
        Ok(replacement) => replacement,
        Err(error) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
                detail: Some(error),
            });
            return MergeAttempt::Failed;
        }
    };

    context.state.max_version = context.state.max_version.max(write.collection_version);
    context.summary.uploaded += 1;
    let (settled_name, source_changed) =
        record_merged_replacement(context, file, &target, replacement);
    context.summary.decide_with(
        SyncPhase::Push,
        &file.name,
        decision::MERGED,
        if source_changed {
            reason::LOCAL_CHANGED_DURING_MERGE
        } else {
            reason::THREE_WAY_MERGE_WAS_CLEAN
        },
        settled_name.clone(),
    );
    // The recorded revision is the base the next push sends its update from,
    // so it must be one the file on disk descends from (RC-82). A file the
    // merged text never reached still descends only from `existing`: the next
    // cycle meets the merged revision as a conflict instead of overwriting it.
    let mut entry = if source_changed {
        existing.clone()
    } else {
        object_state(&write, merged_hash, merged.len() as u64)
    };
    if source_changed || rebased {
        entry.mtime_ms = None;
    }
    MergeAttempt::Applied((settled_name, entry))
}

pub(super) async fn persist_clean_merge(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    existing: &ObjectState,
    conflict: &Conflict,
    target: String,
    local: &str,
    merged: String,
    expected_local_hash: &str,
) -> Result<MergeAttempt, SyncErrorKind> {
    let merged_hash = hash_sha256(&merged);
    let Ok(ciphertext) = encrypt(&context.state.vault_key, &target, &merged) else {
        return Ok(MergeAttempt::Failed);
    };
    let candidate = merged_upload_candidate(
        file,
        existing,
        conflict,
        &target,
        &merged,
        &merged_hash,
        ciphertext,
    );
    let (_, result) =
        dispatch_one_upload(context.http, &context.state.collection_id, candidate).await;

    match result {
        CandidateResult::Updated(write) if write.object.deleted => Ok(create_from_content(
            context,
            &target,
            &merged,
            merged_hash,
            merged.len() as u64,
            file.mtime,
            reason::REMOTE_OBJECT_DELETED,
        )
        .await?
        .map(MergeAttempt::Applied)
        .unwrap_or(MergeAttempt::Failed)),
        CandidateResult::Updated(write) => Ok(apply_merged_write(
            context,
            file,
            MergedWrite {
                target,
                local,
                merged: &merged,
                expected_local_hash,
                merged_hash,
                existing,
                write,
            },
        )),
        CandidateResult::TooLarge => {
            context
                .state
                .oversize_skip
                .insert(file.name.clone(), file.mtime);
            context.summary.conflicts += 1;
            context.summary.decide(
                SyncPhase::Push,
                &file.name,
                decision::SKIPPED_OVERSIZE,
                reason::SERVER_REJECTED_413,
            );
            Ok(MergeAttempt::Failed)
        }
        _ => Ok(MergeAttempt::NeedsConflictCopy),
    }
}

#[cfg(test)]
mod tests {
    use crate::server::{Http, Object};
    use crate::sync::outcome::SyncSummary;

    use super::super::test_support::{connected_state, no_pre, TempRoot};
    use super::*;

    #[test]
    fn occupied_merge_target_journals_the_source_fallback() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("source.md"), "local").unwrap();
        std::fs::write(root.path().join("target.md"), "occupied").unwrap();
        let http = Http::new("http://127.0.0.1:1").unwrap();
        let mut state = connected_state("http://127.0.0.1:1".into());
        let mut summary = SyncSummary::default();
        let mut context = PushContext {
            http: &http,
            state: &mut state,
            root: root.path(),
            summary: &mut summary,
            pre_write: &no_pre,
            save_checkpoint: &|_, _| Ok(()),
        };
        let file = LocalFile {
            name: "source.md".into(),
            mtime: 0,
            size: 5,
        };
        let write = Write {
            object: Object {
                id: "object".into(),
                version: 2,
                change_seq: 2,
                deleted: false,
                blob_key: Some("blob".into()),
                size_bytes: Some(6),
                updated_at: "2026-07-29T12:00:00Z".into(),
            },
            collection_version: 2,
        };

        let existing = ObjectState {
            object_id: "object".into(),
            version: 1,
            blob_key: "base".into(),
            hash: Some(hash_sha256("base")),
            mtime_ms: None,
            size_bytes: Some(4),
        };
        let result = apply_merged_write(
            &mut context,
            &file,
            MergedWrite {
                target: "target.md".into(),
                local: "local",
                merged: "merged",
                expected_local_hash: &hash_sha256("local"),
                merged_hash: hash_sha256("merged"),
                existing: &existing,
                write,
            },
        );

        let MergeAttempt::Applied((settled_name, _)) = result else {
            panic!("merge should use the source fallback");
        };
        assert_eq!(settled_name, "source.md");
        assert_eq!(summary.decisions()[0].detail.as_deref(), Some("source.md"));
    }
}
