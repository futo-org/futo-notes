//! Rename inference, cursor advance, and object identity.

use super::*;

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

/// The rename an open editor has to follow while its content ALSO moved: one
/// server object surfaces under a new name carrying newer bytes (a peer moved
/// the note in one cycle and edited it in the next, and this client pulls both
/// at once). Object identity is what pairs it — `mapped_name` finds the local
/// name currently mapped to the incoming object id — so the pair survives the
/// content change that makes the hash heuristic useless, and the shell follows
/// the rename and then reloads the peer's bytes instead of closing the editor
/// on a note it reads as deleted.
#[test]
fn a_pulled_object_that_changed_name_and_content_together_is_reported_as_a_rename() {
    let root = TempRoot::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();

    std::fs::write(root.path().join("old.md"), "v1").unwrap();
    state
        .object_map
        .insert("old.md".into(), entry("obj-1", Some(&hash_sha256("v1"))));

    let mut moved_and_edited = remote("obj-1", "new.md", "v2 peer edit");
    moved_and_edited.object.version = 2;
    moved_and_edited.object.change_seq = 2;
    moved_and_edited.object.blob_key = Some("blob-obj-1-v2".into());
    apply_remote(
        &mut state,
        root.path(),
        &moved_and_edited,
        &HashMap::new(),
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();

    assert_eq!(summary.renamed.len(), 1);
    assert_eq!(summary.renamed[0].from_id, "old");
    assert_eq!(summary.renamed[0].to_id, "new");
    assert_eq!(read_content(root.path(), "new.md").unwrap(), "v2 peer edit");
    assert!(!root.path().join("old.md").exists());

    // The shell must see the rename plus a real update of the TARGET, and no
    // deletion of the id it is following away from (the from-side ghost).
    let combined = combine(summary, SyncSummary::default());
    assert!(combined.updated_ids.contains(&"new".to_owned()));
    assert!(!combined.deleted_ids.contains(&"old".to_owned()));
    assert!(!combined.peer_deleted_ids.contains(&"old".to_owned()));
}

/// The boundary of that promise, so nobody re-files it as a shell bug: when a
/// peer renames a note OUTSIDE the app (a plain `mv`) and edits it in the same
/// breath, its push has no identity to preserve — the pushing client's
/// rename detection needs an unchanged hash, so it uploads a NEW object and
/// tombstones the old one. The pulling client therefore sees two unrelated
/// objects, and no derivation can honestly pair them: an open editor on the
/// old id is looking at a note that really was deleted, and closing it is the
/// report rendered faithfully, not a lost rename.
#[test]
fn an_external_rename_that_also_edited_the_file_arrives_as_delete_plus_create() {
    let before = HashMap::from([("old.md".into(), entry("obj-old", Some(&hash_sha256("v1"))))]);
    let after = HashMap::from([(
        "new.md".into(),
        entry("obj-new", Some(&hash_sha256("v2 peer edit"))),
    )]);

    assert!(derive_renames(&before, &after).is_empty());
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
