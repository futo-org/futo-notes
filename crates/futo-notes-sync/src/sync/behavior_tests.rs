use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};

use futo_notes_core::conflict_names::collision_conflict_filename;
use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::ObjectState;
use crate::server::Object;

use super::encrypted_note::RemoteNote;
use super::object_map::object_is_current;
use super::outcome::{derive_renames, note_id};
use super::pull::{apply_remote, cap_cursor};
use super::tombstones::{apply_tombstone, claim_local, claim_paths, recover_stale_claims};
use super::vault::{conflict_date, local_files, read_content};

struct TempRoot(std::path::PathBuf);

impl TempRoot {
    fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-sync-engine-test-{}-{n}",
            futo_notes_core::files::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn no_pre(_: &str) {}

fn entry(object_id: &str, hash: Option<&str>) -> ObjectState {
    ObjectState {
        object_id: object_id.into(),
        version: 1,
        blob_key: format!("blob-{object_id}"),
        hash: hash.map(str::to_owned),
        mtime_ms: Some(1_700_000_000_000),
        size_bytes: Some(4),
    }
}

fn connected() -> ConnectedState {
    ConnectedState {
        base_url: "http://127.0.0.1:1".into(),
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: [5; 32],
        object_map: HashMap::new(),
        max_version: 0,
        pull_cursor: 0,
        oversize_skip: HashMap::new(),
    }
}

fn object(id: &str, change_seq: u64, deleted: bool) -> Object {
    Object {
        id: id.into(),
        version: 1,
        change_seq,
        deleted,
        blob_key: (!deleted).then(|| format!("blob-{id}")),
        updated_at: "2026-06-05T12:34:56.789Z".into(),
    }
}

fn remote(id: &str, name: &str, content: &str) -> RemoteNote {
    RemoteNote {
        object: object(id, 1, false),
        name: name.into(),
        content: content.into(),
    }
}

fn failure(kind: FailureKind, status_code: Option<u16>) -> SyncFailure {
    SyncFailure {
        filename: "note.md".into(),
        kind,
        status_code,
    }
}

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

#[test]
fn rename_strips_the_from_side_ghost_delete_but_keeps_target_updates() {
    let push = SyncSummary {
        deleted_ids: vec!["old".into()],
        peer_deleted_ids: vec!["old".into()],
        renamed: vec![RenamePair {
            from_id: "old".into(),
            to_id: "new".into(),
        }],
        ..Default::default()
    };
    let pull = SyncSummary {
        updated_ids: vec!["new".into()],
        peer_updated_ids: vec!["new".into()],
        ..Default::default()
    };
    let combined = combine(push, pull);
    // The from-side "delete at the old name" byproduct is the only ghost.
    assert!(combined.deleted_ids.is_empty());
    assert!(combined.peer_deleted_ids.is_empty());
    // An update recorded against the rename TARGET is a real content event
    // (a same-cycle peer edit to the relocated object), never a byproduct, so
    // it survives — the shell that followed the rename must reload it.
    assert_eq!(combined.updated_ids, ["new"]);
    assert_eq!(combined.peer_updated_ids, ["new"]);
    assert_eq!(combined.renamed.len(), 1);
}

#[test]
fn rename_inference_requires_a_unique_hash_on_both_sides() {
    let before = HashMap::from([("old.md".into(), entry("o1", Some("hash")))]);
    let after = HashMap::from([("new.md".into(), entry("o1", Some("hash")))]);
    let renamed = derive_renames(&before, &after);
    assert_eq!(renamed.len(), 1);
    assert_eq!(renamed[0].from_id, "old");
    assert_eq!(renamed[0].to_id, "new");

    let ambiguous_before = HashMap::from([
        ("a.md".into(), entry("o1", Some("same"))),
        ("b.md".into(), entry("o2", Some("same"))),
    ]);
    let ambiguous_after = HashMap::from([
        ("c.md".into(), entry("o1", Some("same"))),
        ("d.md".into(), entry("o2", Some("same"))),
    ]);
    assert!(derive_renames(&ambiguous_before, &ambiguous_after).is_empty());
}

#[test]
fn cursor_never_advances_past_the_first_failed_change() {
    assert_eq!(cap_cursor(20, None), 20);
    assert_eq!(cap_cursor(20, Some(7)), 6);
    assert_eq!(cap_cursor(5, Some(7)), 5);
    assert_eq!(cap_cursor(20, Some(0)), 0);
}

#[test]
fn same_version_is_current_only_when_the_blob_key_also_matches() {
    let entry = entry("o1", Some("hash"));
    let mut remote = object("o1", 1, false);
    assert!(object_is_current(&entry, &remote));
    remote.blob_key = Some("rotated".into());
    assert!(!object_is_current(&entry, &remote));
}

#[test]
fn identifiers_and_conflict_dates_keep_the_external_shape() {
    assert_eq!(note_id("folder/note.md"), "folder/note");
    assert_eq!(note_id("image.png"), "image.png");
    let date = conflict_date();
    assert_eq!(date.len(), 10);
    assert_eq!(&date[4..5], "-");
    assert_eq!(&date[7..8], "-");
}

#[test]
fn local_scan_ignores_hidden_and_legacy_files_but_keeps_images() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "note").unwrap();
    std::fs::write(root.path().join("image.png"), [1, 2, 3]).unwrap();
    std::fs::write(root.path().join("legacy.tiff"), [1, 2, 3]).unwrap();
    std::fs::write(root.path().join(".hidden.md"), "hidden").unwrap();
    std::fs::create_dir(root.path().join(".hidden")).unwrap();
    std::fs::write(root.path().join(".hidden/note.md"), "hidden").unwrap();
    let names: Vec<_> = local_files(root.path())
        .unwrap()
        .into_iter()
        .map(|file| file.name)
        .collect();
    assert_eq!(names, ["image.png", "note.md"]);
}

#[test]
fn incoming_names_are_ignored_healed_or_rejected_before_writing() {
    let root = TempRoot::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();
    let ancestry = HashMap::new();

    apply_remote(
        &mut state,
        root.path(),
        &remote("legacy", "scan.tiff", "AAAA"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();
    assert!(!root.path().join("scan.tiff").exists());

    apply_remote(
        &mut state,
        root.path(),
        &remote("healed", "CON.md", "device"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join("CON_.md")).unwrap(),
        "device"
    );
    assert!(state.object_map.contains_key("CON_.md"));

    apply_remote(
        &mut state,
        root.path(),
        &remote("unsafe", "../escape.md", "evil"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();
    assert!(!root.path().join("escape.md").exists());
    assert_eq!(summary.failures.len(), 1);
    assert_eq!(summary.failures[0].kind, FailureKind::Rejected);
    assert!(!summary.failure_message().unwrap().contains("will retry"));
}

#[test]
fn colliding_remote_notes_both_survive_but_identical_content_deduplicates() {
    let root = TempRoot::new();
    let ancestry = HashMap::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();

    apply_remote(
        &mut state,
        root.path(),
        &remote("a-object", "note.md", "first"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();
    apply_remote(
        &mut state,
        root.path(),
        &remote("b-object", "note.md", "second"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();
    let files = local_files(root.path()).unwrap();
    assert_eq!(files.len(), 2);
    let contents: HashSet<_> = files
        .iter()
        .map(|file| read_content(root.path(), &file.name).unwrap())
        .collect();
    assert_eq!(contents, HashSet::from(["first".into(), "second".into()]));

    let before = local_files(root.path()).unwrap().len();
    apply_remote(
        &mut state,
        root.path(),
        &remote("c-object", "note.md", "first"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();
    assert_eq!(local_files(root.path()).unwrap().len(), before);
}

#[test]
fn collision_placement_reports_the_relocated_local_note_as_a_rename() {
    let root = TempRoot::new();
    let ancestry = HashMap::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();

    // A locally-mapped note holds the canonical name; a rival remote object
    // with a smaller object id arrives under the same name and wins it.
    std::fs::write(root.path().join("note.md"), "local text").unwrap();
    state.object_map.insert(
        "note.md".into(),
        entry("z-local", Some(&hash_sha256("local text"))),
    );

    apply_remote(
        &mut state,
        root.path(),
        &remote("a-remote", "note.md", "remote text"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();

    // The loser survives at its deterministic conflict name, and the
    // placement is reported as rename intent in the summary — shells follow
    // it verbatim instead of inferring a rename from id patterns.
    let conflict = collision_conflict_filename("note.md", "z-local");
    assert_eq!(read_content(root.path(), &conflict).unwrap(), "local text");
    assert_eq!(read_content(root.path(), "note.md").unwrap(), "remote text");
    assert_eq!(summary.renamed.len(), 1);
    assert_eq!(summary.renamed[0].from_id, "note");
    assert_eq!(summary.renamed[0].to_id, note_id(&conflict));
}

#[cfg(unix)]
#[test]
fn collision_rename_retry_resyncs_the_destination_before_state_advances() {
    let root = TempRoot::new();
    let ancestry = HashMap::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();
    std::fs::write(root.path().join("note.md"), "local text").unwrap();
    state.object_map.insert(
        "note.md".into(),
        entry("z-local", Some(&hash_sha256("local text"))),
    );
    let incoming = remote("a-remote", "note.md", "remote text");
    super::vault_fs::fail_directory_sync_on_call(1);

    assert!(apply_remote(
        &mut state,
        root.path(),
        &incoming,
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .is_err());
    assert!(state.object_map.contains_key("note.md"));

    super::vault_fs::fail_directory_sync_on_call(2);
    let retry = apply_remote(
        &mut state,
        root.path(),
        &incoming,
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap_err();

    assert!(retry.contains("sync destination directory after rename"));
    assert!(state.object_map.contains_key("note.md"));
}

#[cfg(unix)]
#[test]
fn collision_placement_never_renames_through_a_symlinked_parent() {
    use std::os::unix::fs::symlink;

    let root = TempRoot::new();
    let outside = TempRoot::new();
    let ancestry = HashMap::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();
    let outside_note = outside.path().join("note.md");
    std::fs::write(&outside_note, "outside text").unwrap();
    symlink(outside.path(), root.path().join("linked")).unwrap();
    state.object_map.insert(
        "linked/note.md".into(),
        entry("z-local", Some(&hash_sha256("outside text"))),
    );

    assert!(apply_remote(
        &mut state,
        root.path(),
        &remote("a-remote", "linked/note.md", "remote text"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .is_err());

    assert_eq!(
        std::fs::read_to_string(&outside_note).unwrap(),
        "outside text"
    );
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
}

#[test]
fn identical_content_collision_dedup_reports_no_rename() {
    let root = TempRoot::new();
    let ancestry = HashMap::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();

    // The byte-identical loser adopts silently (map entry dropped, no
    // conflict copy) — there is no relocation, so no rename intent either.
    std::fs::write(root.path().join("note.md"), "same text").unwrap();
    state.object_map.insert(
        "note.md".into(),
        entry("z-local", Some(&hash_sha256("same text"))),
    );

    apply_remote(
        &mut state,
        root.path(),
        &remote("a-remote", "note.md", "same text"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();

    assert!(summary.renamed.is_empty());
    assert_eq!(local_files(root.path()).unwrap().len(), 1);
}

#[test]
fn same_cycle_tombstone_of_a_collision_relocated_note_survives_ghost_stripping() {
    let root = TempRoot::new();
    let ancestry = HashMap::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();

    // The mapped local note loses the shared name to a rival remote object,
    // so the collision placement relocates it and reports a rename.
    std::fs::write(root.path().join("note.md"), "local text").unwrap();
    state.object_map.insert(
        "note.md".into(),
        entry("z-local", Some(&hash_sha256("local text"))),
    );
    apply_remote(
        &mut state,
        root.path(),
        &remote("a-remote", "note.md", "remote text"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();

    // The same pull then delivers the peer's tombstone for that object: the
    // relocated conflict copy is removed at its new name.
    apply_tombstone(
        &mut state,
        root.path(),
        &object("z-local", 2, true),
        &ancestry,
        &no_pre,
        &mut summary,
    )
    .unwrap();
    let conflict = collision_conflict_filename("note.md", "z-local");
    assert!(!root.path().join(&conflict).exists());

    // Ghost-stripping in combine() must not erase the deletion just because
    // the deleted id was a rename target earlier in the same cycle — shells
    // follow the rename and need the deletion to close the open note instead
    // of leaving the editor bound to a note that no longer exists.
    let combined = combine(summary, SyncSummary::default());
    assert_eq!(combined.renamed.len(), 1);
    assert!(combined.deleted_ids.contains(&note_id(&conflict)));
    assert!(combined.peer_deleted_ids.contains(&note_id(&conflict)));
}

#[test]
fn same_cycle_update_of_a_collision_relocated_note_survives_ghost_stripping() {
    let root = TempRoot::new();
    let ancestry = HashMap::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();

    // The mapped local note loses the shared name to a rival remote object,
    // so the collision placement relocates it and reports a rename.
    std::fs::write(root.path().join("note.md"), "local text").unwrap();
    state.object_map.insert(
        "note.md".into(),
        entry("z-local", Some(&hash_sha256("local text"))),
    );
    apply_remote(
        &mut state,
        root.path(),
        &remote("a-remote", "note.md", "remote text"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();

    // The same pull then delivers a newer peer edit to that same object,
    // which now lives under its conflict name.
    let mut peer_edit = remote("z-local", "note.md", "peer edit");
    peer_edit.object.version = 2;
    peer_edit.object.change_seq = 2;
    peer_edit.object.blob_key = Some("blob-z-local-v2".into());
    apply_remote(
        &mut state,
        root.path(),
        &peer_edit,
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();
    let conflict = collision_conflict_filename("note.md", "z-local");
    assert_eq!(read_content(root.path(), &conflict).unwrap(), "peer edit");

    // Ghost-stripping in combine() must not erase that update just because the
    // updated id was a rename target earlier in the same cycle — the shell
    // followed the rename and must reload the peer's content, or its next save
    // overwrites the peer edit on every client.
    let combined = combine(summary, SyncSummary::default());
    assert_eq!(combined.renamed.len(), 1);
    assert!(combined.updated_ids.contains(&note_id(&conflict)));
    assert!(combined.peer_updated_ids.contains(&note_id(&conflict)));
}

#[test]
fn tombstone_deletes_unchanged_content_and_parks_a_divergent_edit() {
    let root = TempRoot::new();
    let ancestry = HashMap::new();

    std::fs::write(root.path().join("same.md"), "original").unwrap();
    let mut same_state = connected();
    same_state.object_map.insert(
        "same.md".into(),
        entry("same-object", Some(&hash_sha256("original"))),
    );
    let mut same_summary = SyncSummary::default();
    apply_tombstone(
        &mut same_state,
        root.path(),
        &object("same-object", 5, true),
        &ancestry,
        &no_pre,
        &mut same_summary,
    )
    .unwrap();
    assert!(!root.path().join("same.md").exists());
    assert_eq!(same_summary.deleted, 1);

    std::fs::write(root.path().join("edited.md"), "local edit").unwrap();
    let mut edited_state = connected();
    edited_state.object_map.insert(
        "edited.md".into(),
        entry("edited-object", Some(&hash_sha256("old base"))),
    );
    let mut edited_summary = SyncSummary::default();
    apply_tombstone(
        &mut edited_state,
        root.path(),
        &object("edited-object", 6, true),
        &ancestry,
        &no_pre,
        &mut edited_summary,
    )
    .unwrap();
    assert!(!root.path().join("edited.md").exists());
    let copy = collision_conflict_filename("edited.md", "edited-object");
    assert_eq!(
        std::fs::read_to_string(root.path().join(copy)).unwrap(),
        "local edit"
    );
    assert_eq!(edited_summary.conflicts, 1);
}

#[test]
fn tombstone_without_identity_or_ancestry_cannot_delete_an_unrelated_file() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("keep.md"), "keep").unwrap();
    let mut state = connected();
    let mut summary = SyncSummary::default();
    apply_tombstone(
        &mut state,
        root.path(),
        &object("unknown", 3, true),
        &HashMap::new(),
        &no_pre,
        &mut summary,
    )
    .unwrap();
    assert!(root.path().join("keep.md").exists());
    assert_eq!(summary.deleted, 0);
}

#[test]
fn stale_tombstone_claim_is_restored_after_a_crash() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "recover me").unwrap();
    let (claim, sidecar) = claim_local(root.path(), "note.md", "o1", &no_pre)
        .unwrap()
        .unwrap();
    assert!(claim.exists());
    assert!(sidecar.exists());
    assert!(!root.path().join("note.md").exists());

    recover_stale_claims(root.path(), &no_pre);
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "recover me"
    );
    assert!(!claim.exists());
    assert!(!sidecar.exists());
}

#[cfg(unix)]
#[test]
fn tombstone_claim_keeps_recovery_sidecar_after_uncertain_rename() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "recover me").unwrap();
    let (claim, sidecar) = claim_paths(root.path(), "note.md", "o1");
    super::vault_fs::fail_directory_sync_on_call(2);

    let error = claim_local(root.path(), "note.md", "o1", &no_pre).unwrap_err();

    assert!(error.contains("sync source directory after rename"));
    assert!(!root.path().join("note.md").exists());
    assert_eq!(std::fs::read_to_string(&claim).unwrap(), "recover me");
    assert_eq!(std::fs::read_to_string(&sidecar).unwrap(), "note.md");

    recover_stale_claims(root.path(), &no_pre);
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "recover me"
    );
    assert!(!claim.exists());
    assert!(!sidecar.exists());
}

#[test]
fn recreated_original_wins_over_a_stale_claim() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "old").unwrap();
    let (claim, sidecar) = claim_local(root.path(), "note.md", "o1", &no_pre)
        .unwrap()
        .unwrap();
    std::fs::write(root.path().join("note.md"), "new").unwrap();

    recover_stale_claims(root.path(), &no_pre);
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.md")).unwrap(),
        "new"
    );
    assert!(!claim.exists());
    assert!(!sidecar.exists());
}

#[test]
fn failed_stale_claim_restore_keeps_the_recoverable_bytes() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("folder"), "blocks directory creation").unwrap();
    let (claim, sidecar) = claim_paths(root.path(), "folder/note.md", "o1");
    std::fs::write(&claim, "recover me later").unwrap();
    std::fs::write(&sidecar, "folder/note.md").unwrap();

    recover_stale_claims(root.path(), &no_pre);

    assert_eq!(std::fs::read_to_string(&claim).unwrap(), "recover me later");
    assert!(sidecar.exists());
    assert!(!root.path().join("folder/note.md").exists());
}

#[test]
fn stale_claim_sweep_cleans_orphan_sidecars_without_guessing_claim_paths() {
    let root = TempRoot::new();
    let (claim, sidecar) = claim_paths(root.path(), "note.md", "o1");
    std::fs::write(&sidecar, "note.md").unwrap();
    recover_stale_claims(root.path(), &no_pre);
    assert!(!sidecar.exists());

    std::fs::write(&claim, "unknown origin").unwrap();
    recover_stale_claims(root.path(), &no_pre);
    assert_eq!(std::fs::read_to_string(&claim).unwrap(), "unknown origin");
}

#[test]
fn tombstone_io_error_is_not_reported_as_convergence() {
    let root = TempRoot::new();
    std::fs::create_dir(root.path().join("note.md")).unwrap();
    let mut state = connected();
    state.object_map.insert(
        "note.md".into(),
        entry("o1", Some(&hash_sha256("expected file content"))),
    );
    let mut summary = SyncSummary::default();

    assert!(apply_tombstone(
        &mut state,
        root.path(),
        &object("o1", 4, true),
        &HashMap::new(),
        &no_pre,
        &mut summary,
    )
    .is_err());
    assert!(root.path().join("note.md").is_dir());
    assert!(state.object_map.contains_key("note.md"));
    assert_eq!(summary.deleted, 0);
}

#[test]
fn claim_names_are_bounded_even_for_deep_long_paths() {
    let root = TempRoot::new();
    let name = format!("{}/{}.md", "deep/".repeat(40), "x".repeat(240));
    let (claim, sidecar) = claim_paths(root.path(), &name, "object");
    assert!(claim.file_name().unwrap().len() < 255);
    assert!(sidecar.file_name().unwrap().len() < 255);
}
