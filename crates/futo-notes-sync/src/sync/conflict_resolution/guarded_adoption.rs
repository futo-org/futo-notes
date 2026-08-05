use crate::checkpoint::ObjectState;
use crate::server::timestamp_ms;

use super::super::encrypted_note::{state_from_remote, RemoteNote};
use super::super::outcome::note_id;
use super::super::push::PushContext;
use super::super::vault::{replace_content_if_hash_matches, GuardedWriteOutcome, LocalFile};
use super::super::{decision, FailureKind, RenamePair, SyncFailure, SyncPhase};
use super::reason;

pub(super) enum GuardedReplacement {
    Applied(String),
    SourceChanged,
}

pub(super) fn replace_with_source_fallback(
    context: &PushContext<'_>,
    file: &LocalFile,
    target: &str,
    content: &str,
    expected_local_hash: &str,
    modified: i64,
) -> Result<GuardedReplacement, String> {
    match replace_content_if_hash_matches(
        context.root,
        &file.name,
        target,
        content,
        expected_local_hash,
        modified,
        context.pre_write,
    )? {
        GuardedWriteOutcome::Applied => Ok(GuardedReplacement::Applied(target.to_owned())),
        GuardedWriteOutcome::SourceChanged => Ok(GuardedReplacement::SourceChanged),
        GuardedWriteOutcome::TargetOccupied => {
            replace_at_source(context, file, content, expected_local_hash, modified)
        }
    }
}

fn replace_at_source(
    context: &PushContext<'_>,
    file: &LocalFile,
    content: &str,
    expected_local_hash: &str,
    modified: i64,
) -> Result<GuardedReplacement, String> {
    let outcome = replace_content_if_hash_matches(
        context.root,
        &file.name,
        &file.name,
        content,
        expected_local_hash,
        modified,
        context.pre_write,
    )?;
    match outcome {
        GuardedWriteOutcome::Applied => Ok(GuardedReplacement::Applied(file.name.clone())),
        GuardedWriteOutcome::SourceChanged | GuardedWriteOutcome::TargetOccupied => {
            Ok(GuardedReplacement::SourceChanged)
        }
    }
}

fn record_remote_rename(context: &mut PushContext<'_>, source: &str, settled_name: &str) {
    context.summary.local_writes_applied += 1;
    context.summary.deleted_ids.push(note_id(source));
    context.summary.updated_ids.push(note_id(settled_name));
    context.summary.peer_updated_ids.push(note_id(settled_name));
    context.summary.renamed.push(RenamePair {
        from_id: note_id(source),
        to_id: note_id(settled_name),
    });
}

fn dirty_remote_state(remote: &RemoteNote) -> ObjectState {
    let mut entry = state_from_remote(remote);
    entry.mtime_ms = None;
    entry
}

pub(super) fn adopt_matching_remote(
    context: &mut PushContext<'_>,
    file: &LocalFile,
    local: &str,
    local_hash: &str,
    remote: &RemoteNote,
    remote_name: String,
) -> Option<(String, ObjectState)> {
    let replacement = replace_with_source_fallback(
        context,
        file,
        &remote_name,
        local,
        local_hash,
        timestamp_ms(&remote.object.updated_at),
    );
    let replacement = match replacement {
        Ok(replacement) => replacement,
        Err(_) => {
            context.summary.failures.push(SyncFailure {
                filename: file.name.clone(),
                kind: FailureKind::Upload,
                status_code: None,
            });
            return None;
        }
    };
    let GuardedReplacement::Applied(settled_name) = replacement else {
        return Some((file.name.clone(), dirty_remote_state(remote)));
    };

    if settled_name != remote_name {
        context.summary.conflicts += 1;
    }
    if settled_name != file.name {
        record_remote_rename(context, &file.name, &settled_name);
    }
    context.summary.decide_with(
        SyncPhase::Push,
        &file.name,
        decision::ADOPTED_REMOTE,
        reason::REMOTE_ALREADY_HOLDS_LOCAL,
        settled_name.clone(),
    );
    Some((settled_name, state_from_remote(remote)))
}

#[cfg(test)]
mod tests {
    use futo_notes_core::hash::hash_sha256;

    use crate::server::Http;
    use crate::sync::outcome::SyncSummary;

    use super::super::test_support::{connected_state, no_pre, remote_note, TempRoot};
    use super::*;

    #[test]
    fn occupied_remote_rename_falls_back_to_the_source_path() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("source.md"), "matching content").unwrap();
        std::fs::write(root.path().join("target.md"), "independent target").unwrap();
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
            size: 16,
        };
        let remote = remote_note("target.md", "matching content");

        let (settled_name, settled_state) = adopt_matching_remote(
            &mut context,
            &file,
            "matching content",
            &hash_sha256("matching content"),
            &remote,
            remote.name.clone(),
        )
        .unwrap();

        assert_eq!(settled_name, "source.md");
        assert_eq!(settled_state.object_id, "remote-object");
        assert_eq!(summary.conflicts, 1);
        assert_eq!(
            std::fs::read_to_string(root.path().join("source.md")).unwrap(),
            "matching content"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("target.md")).unwrap(),
            "independent target"
        );
    }
}
