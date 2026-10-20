//! Tombstones: claims, parking divergent edits, and crash recovery.

use super::*;

#[test]
fn tombstone_claim_waits_for_a_flush_owned_vault_span() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "base").unwrap();
    let flush_guard = futo_notes_core::files::vault_mutation_guard().unwrap();
    let claim_root = root.path().to_owned();
    let (started_tx, started_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();

    let claim = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        let result = claim_local(&claim_root, "note.md", "object", &no_pre);
        finished_tx.send(result).unwrap();
    });
    started_rx.recv().expect("tombstone claim started");
    assert!(
        finished_rx.recv_timeout(Duration::from_millis(75)).is_err(),
        "tombstone rename must wait while flush owns the vault span"
    );

    drop(flush_guard);
    // Join, not a wall-clock budget: once the guard is dropped the claim has to
    // win the same PROCESS-WIDE guard against every other test in this binary,
    // so a deadline here would measure queue depth instead of the claim (the
    // store-side twin of this test failed exactly that way in job 217730).
    claim.join().unwrap();
    finished_rx
        .try_recv()
        .expect("tombstone claim proceeds after flush")
        .unwrap()
        .expect("note was claimed");
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

/// A tombstone park moves the local content to a conflict copy, so it is a
/// relocation and must report rename intent like every other relocation — the
/// shell has no other way to follow its open editor to the copy. Reporting only
/// the deletion closed the editor of a user whose draft had already reached disk
/// (the autosave landed between this cycle's push and pull, so the classifier
/// saw a peer delete with nothing left to preserve) while the draft sat in the
/// copy: the disp-05 KeepDraft flake, journal decision `tombstone_parked` /
/// `local_content_diverged_from_the_deleted_version`.
#[test]
fn tombstone_park_of_diverged_content_reports_rename_intent() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("edited.md"), "local draft").unwrap();
    let mut state = connected();
    state.object_map.insert(
        "edited.md".into(),
        entry("edited-object", Some(&hash_sha256("old base"))),
    );
    let mut summary = SyncSummary::default();

    apply_tombstone(
        &mut state,
        root.path(),
        &object("edited-object", 6, true),
        &HashMap::new(),
        &no_pre,
        &mut summary,
    )
    .unwrap();

    let copy = collision_conflict_filename("edited.md", "edited-object");
    assert_eq!(summary.renamed.len(), 1, "the park must report one rename");
    assert_eq!(summary.renamed[0].from_id, note_id("edited.md"));
    assert_eq!(summary.renamed[0].to_id, note_id(&copy));

    // The "delete at the old name" is this relocation's byproduct, so
    // ghost-stripping removes it: the open tab moved, it was not deleted.
    let combined = combine(summary, SyncSummary::default());
    assert!(!combined.deleted_ids.contains(&note_id("edited.md")));
    assert!(!combined.peer_deleted_ids.contains(&note_id("edited.md")));
    assert!(combined.updated_ids.contains(&note_id(&copy)));
}

/// A tombstone whose local content still matches the deleted version is a plain
/// deletion — nothing relocated, so nothing to follow, and the clean open
/// editor must still be told the note is gone (never left on a deleted id, F4).
#[test]
fn tombstone_of_unchanged_content_reports_no_rename() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("same.md"), "original").unwrap();
    let mut state = connected();
    state.object_map.insert(
        "same.md".into(),
        entry("same-object", Some(&hash_sha256("original"))),
    );
    let mut summary = SyncSummary::default();

    apply_tombstone(
        &mut state,
        root.path(),
        &object("same-object", 5, true),
        &HashMap::new(),
        &no_pre,
        &mut summary,
    )
    .unwrap();

    assert!(summary.renamed.is_empty());
    let combined = combine(summary, SyncSummary::default());
    assert!(combined.deleted_ids.contains(&note_id("same.md")));
    assert!(combined.peer_deleted_ids.contains(&note_id("same.md")));
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

/// A remote name no portable filesystem can hold is IGNORED, not rejected
/// (github#15 follow-up): nothing is written, no failure reaches the user, and
/// the only trace is a journal decision. Before this change it raised a
/// permanent `rejected` failure on every peer, on every cycle, forever — for a
/// note the origin device never displayed in the first place.
#[test]
fn an_unportable_remote_name_is_ignored_without_a_failure() {
    let root = TempRoot::new();
    let mut state = connected();
    let mut summary = SyncSummary::default();
    let ancestry = HashMap::new();

    apply_remote(
        &mut state,
        root.path(),
        &remote("unportable", "Recipe: braised short ribs.md", "body"),
        &ancestry,
        false,
        &no_pre,
        &mut summary,
    )
    .unwrap();

    assert!(!root.path().join("Recipe: braised short ribs.md").exists());
    assert!(state.object_map.is_empty(), "nothing was mapped");
    assert!(
        summary.failures.is_empty(),
        "the user is never told: {:?}",
        summary.failures,
    );
    let journaled = summary
        .decisions()
        .iter()
        .filter(|entry| entry.decision == decision::IGNORED)
        .map(|entry| entry.filename.as_str())
        .collect::<Vec<_>>();
    assert_eq!(journaled, vec!["Recipe: braised short ribs.md"]);
}
