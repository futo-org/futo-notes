//! Incoming names and remote notes that collide on one path.

use super::*;

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

#[test]
fn three_uuid_v7_name_rivals_keep_all_three_bodies() {
    let root = TempRoot::new();
    let ancestry = HashMap::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();
    let winner = "019a7364-3120-7000-8000-000000000000";
    let first = "019a7364-3120-7000-8000-000000000001";
    let second = "019a7364-3120-7000-8000-000000000002";
    std::fs::write(root.path().join("note.md"), "first body").unwrap();
    state.object_map.insert(
        "note.md".into(),
        entry(first, Some(&hash_sha256("first body"))),
    );

    apply_remote(
        &mut state,
        root.path(),
        &remote(winner, "note.md", "winner body"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();
    apply_remote(
        &mut state,
        root.path(),
        &remote(second, "note.md", "second body"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();

    let first_name = collision_conflict_filename("note.md", first);
    let second_name = collision_conflict_filename("note.md", second);
    assert_ne!(first_name, second_name);
    assert_eq!(read_content(root.path(), "note.md").unwrap(), "winner body");
    assert_eq!(
        read_content(root.path(), &first_name).unwrap(),
        "first body"
    );
    assert_eq!(
        read_content(root.path(), &second_name).unwrap(),
        "second body"
    );
    assert_eq!(state.object_map.len(), 3);
}

#[test]
fn collision_destination_already_on_disk_is_never_replaced() {
    let root = TempRoot::new();
    let id = "019a7364-3120-7000-8000-000000000001";
    let target = collision_conflict_filename("note.md", id);
    std::fs::write(root.path().join("note.md"), "source body").unwrap();
    std::fs::write(root.path().join(&target), "existing body").unwrap();

    assert!(super::vault::rename_local(root.path(), "note.md", &target).is_err());
    assert_eq!(read_content(root.path(), "note.md").unwrap(), "source body");
    assert_eq!(read_content(root.path(), &target).unwrap(), "existing body");
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

    assert!(retry.contains("sync"), "{retry}");
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
