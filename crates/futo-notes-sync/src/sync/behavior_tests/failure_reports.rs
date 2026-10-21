//! How a cycle's failures are worded, combined, and retried.

use super::*;

#[test]
fn failure_messages_are_honest_and_deterministic() {
    assert_eq!(SyncSummary::default().failure_message(), None);

    let summary = SyncSummary {
        failures: vec![
            failure(FailureKind::Upload, Some(500)),
            failure(FailureKind::Delete, Some(409)),
            failure(FailureKind::Upload, Some(409)),
            failure(FailureKind::Download, None),
            failure(FailureKind::Decrypt, None),
            failure(FailureKind::Checkpoint, None),
        ],
        ..Default::default()
    };
    assert_eq!(
            summary.failure_message().as_deref(),
            Some(
                "3 changes couldn't reach the server (HTTP 409); 1 note couldn't be downloaded (will retry); 1 note couldn't be decrypted; sync state couldn't be saved locally"
            )
        );

    let tie = SyncSummary {
        failures: vec![
            failure(FailureKind::Upload, Some(503)),
            failure(FailureKind::Delete, Some(500)),
        ],
        ..Default::default()
    };
    assert!(tie.failure_message().unwrap().contains("HTTP 503"));
}

#[test]
fn failure_kind_wire_strings_are_stable() {
    assert_eq!(FailureKind::Upload.as_str(), "upload");
    assert_eq!(FailureKind::Delete.as_str(), "delete");
    assert_eq!(FailureKind::Checkpoint.as_str(), "checkpoint");
    assert_eq!(FailureKind::Download.as_str(), "download");
    assert_eq!(FailureKind::Decrypt.as_str(), "decrypt");
    assert_eq!(FailureKind::Rejected.as_str(), "rejected");
    assert_eq!(FailureKind::LocalApply.as_str(), "local_apply");
    assert_eq!(FailureKind::VaultMissing.as_str(), "vault_missing");
}

/// The tripwire for [`SyncFailure`]'s shape, matching the one
/// [`SyncSummary`] has. Both shell projections build their own failure struct
/// field by field, so a new engine field is invisible to them: `detail` was
/// added for the instance journal and must stay out of the shell contracts,
/// and the next field has to make that call deliberately rather than by
/// omission.
#[test]
fn every_failure_field_is_either_projected_or_deliberately_internal() {
    let SyncFailure {
        // Projected to both shell families.
        filename: _,
        kind: _,
        status_code: _,
        // Deliberately NOT projected: instance-journal diagnostics.
        detail: _,
    } = failure(FailureKind::Upload, None);
}

/// github#44 in one assertion: a missing vault folder answers alone, by path,
/// with the way out — it explains every other failure in the cycle, so burying
/// it in a list of per-note bullets hides the only line the user can act on.
#[test]
fn a_missing_vault_folder_answers_alone_and_names_the_folder() {
    let summary = SyncSummary {
        failures: vec![
            SyncFailure {
                filename: "/home/j/Notes".into(),
                kind: FailureKind::VaultMissing,
                status_code: None,
                detail: None,
            },
            SyncFailure {
                filename: "/home/j/Notes".into(),
                kind: FailureKind::VaultMissing,
                status_code: None,
                detail: None,
            },
            failure(FailureKind::Download, Some(502)),
            failure(FailureKind::Upload, Some(500)),
        ],
        ..Default::default()
    };
    assert_eq!(
        summary.failure_message().as_deref(),
        Some("Can't find your vault folder at /home/j/Notes. Please reconfigure in settings.")
    );
}

/// A local apply fault never borrows the network wording, and a download names
/// the status the engine has always collected and used to throw away.
#[test]
fn local_and_download_failures_read_differently() {
    let summary = SyncSummary {
        failures: vec![
            failure(FailureKind::LocalApply, None),
            failure(FailureKind::LocalApply, None),
            failure(FailureKind::Download, Some(502)),
        ],
        ..Default::default()
    };
    assert_eq!(
        summary.failure_message().as_deref(),
        Some(
            "1 note couldn't be downloaded (HTTP 502) (will retry); \
2 changes couldn't be applied to your notes folder (will retry)"
        )
    );
}

#[test]
fn combined_summary_keeps_counts_failures_and_unique_ids() {
    let push = SyncSummary {
        uploaded: 2,
        downloaded: 1,
        local_writes_applied: 1,
        failures: vec![failure(FailureKind::Upload, Some(500))],
        updated_ids: vec!["same".into()],
        ..Default::default()
    };
    let pull = SyncSummary {
        uploaded: 1,
        downloaded: 3,
        local_writes_applied: 4,
        failures: vec![failure(FailureKind::Download, None)],
        updated_ids: vec!["same".into(), "new".into()],
        ..Default::default()
    };
    let combined = combine(push, pull);
    assert_eq!(combined.uploaded, 3);
    assert_eq!(combined.downloaded, 4);
    assert_eq!(combined.local_writes_applied, 5);
    assert_eq!(combined.failures.len(), 2);
    assert_eq!(combined.updated_ids, ["same", "new"]);
}

#[test]
fn combined_summary_records_checkpoint_failure_once_per_cycle() {
    let push = SyncSummary {
        failures: vec![failure(FailureKind::Checkpoint, None)],
        ..Default::default()
    };
    let pull = SyncSummary {
        failures: vec![failure(FailureKind::Checkpoint, None)],
        ..Default::default()
    };

    let combined = combine(push, pull);

    assert_eq!(combined.failures.len(), 1);
    assert_eq!(combined.failures[0].kind, FailureKind::Checkpoint);
}

#[cfg(unix)]
#[test]
fn matching_remote_retry_resyncs_before_advancing_the_object_map() {
    let root = TempRoot::new();
    let remote = remote("remote", "note.md", "body");
    let mut state = connected();
    let mut summary = SyncSummary::default();
    super::vault_fs::fail_directory_sync_on_call(2);

    let first = apply_remote(
        &mut state,
        root.path(),
        &remote,
        &HashMap::new(),
        false,
        &no_pre,
        &mut summary,
    );

    assert!(first.is_err());
    assert!(state.object_map.is_empty());
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "body"
    );

    super::vault_fs::fail_directory_sync_on_call(1);
    let retry = apply_remote(
        &mut state,
        root.path(),
        &remote,
        &HashMap::new(),
        false,
        &no_pre,
        &mut summary,
    );

    assert!(retry.is_err());
    assert!(state.object_map.is_empty());
}

/// github#44, at the level the user meets it. A cycle whose vault folder is not
/// there must stop before its first write, say which folder and where to fix
/// it, and leave the folder alone.
///
/// Both halves of that are regressions. It used to report "N notes couldn't be
/// downloaded (will retry)" — sending the reporter to audit a healthy server,
/// a healthy nginx and his server logs — and then `checkpoint::save` recreated
/// the folder behind him, because `write_atomic_text` does `create_dir_all` on
/// the parent. A vanished vault must never be replaced by an empty directory
/// (the desktop states that rule in `vault_location.rs` `resolve_root`); the
/// engine silently did it anyway and left a stub holding `.e2ee-state.json`.
#[tokio::test]
async fn a_cycle_with_no_vault_folder_names_it_and_does_not_recreate_it() {
    let holder = TempRoot::new();
    let missing = holder.path().join("vault-gone");
    let state = connected();

    let error = cycle(
        &state,
        &missing,
        &|_| {},
        &no_pre,
        &crate::journal::SyncRunJournal::disabled(),
    )
    .await
    .expect_err("a cycle with no vault folder cannot succeed");

    assert_eq!(
        error.message(),
        format!(
            "Can't find your vault folder at {}. Please reconfigure in settings.",
            missing.display()
        )
    );
    assert!(
        !missing.exists(),
        "a vanished vault must never be replaced by an empty directory"
    );
}
