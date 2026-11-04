use super::*;
use crate::NoteRename;

#[test]
fn reported_remote_rename_retains_draft_selection_history_and_merges_at_final_id() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "first\n\nsecond\n").unwrap();
    store.create("", "wanted", "unrelated collision").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(7, 13), "LOCAL").unwrap();
    let selection = editor.selection();
    // The sync writer reports its allocated final id; it is not a title hint.
    fs::rename(root.0.join("old.md"), root.0.join("wanted (2).md")).unwrap();
    fs::write(root.0.join("wanted (2).md"), "REMOTE\n\nsecond\n").unwrap();
    let rename = NoteRename {
        from: "old".into(),
        to: "wanted (2)".into(),
    };
    let mutation = store
        .refresh_external_changes(&[], &[], &[rename.clone()])
        .unwrap();
    assert_eq!(mutation.renamed, [rename]);
    assert_eq!(editor.id(), "wanted (2)");
    assert_eq!(editor.source_text(), "first\n\nLOCAL\n");
    assert_eq!(editor.selection(), selection);
    assert_eq!(editor.revision(), Revision(1));
    let saved = editor.checkpoint().unwrap();
    assert_eq!(
        saved.mutation.unwrap().final_id.as_deref(),
        Some("wanted (2)")
    );
    assert_eq!(store.read_existing("old").unwrap(), None);
    assert_eq!(store.read("wanted").unwrap(), "unrelated collision");
    assert_eq!(store.read("wanted (2)").unwrap(), "REMOTE\n\nLOCAL\n");
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\nsecond\n");
}

#[test]
fn reported_rename_overlap_parks_both_versions_and_replayed_completion_cannot_reattach() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(0, 4), "local").unwrap();
    fs::rename(root.0.join("old.md"), root.0.join("remote.md")).unwrap();
    let rename = NoteRename {
        from: "old".into(),
        to: "remote".into(),
    };
    store
        .refresh_external_changes(&[], &[], &[rename.clone()])
        .unwrap();
    // A subsequent peer save must be considered at the authoritative id too.
    store.write("remote", "peer", None).unwrap();
    let saved = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("overlap must preserve the peer and park the draft");
    };
    assert_eq!(
        saved.mutation.unwrap().final_id.as_deref(),
        Some(parked_id.as_str())
    );
    store.refresh_external_changes(&[], &[], &[rename]).unwrap();
    assert_eq!(editor.id(), parked_id);
    assert_eq!(store.read("remote").unwrap(), "peer");
    assert_eq!(store.read(&parked_id).unwrap(), "local");
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "base");
    assert_eq!(store.read_existing("old").unwrap(), None);
}

#[test]
fn failed_external_rename_keeps_attachment_source_and_history_for_retry() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    store.create("", "new", "destination").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();
    let destination = store.open_editor("new").unwrap();
    let rename = NoteRename {
        from: "old".into(),
        to: "new".into(),
    };
    fs::remove_file(root.0.join("old.md")).unwrap();
    assert!(store
        .refresh_external_changes(&[], &[], &[rename.clone()])
        .is_err());
    assert_eq!(editor.id(), "old");
    assert_eq!(editor.source_text(), "base draft");
    assert_eq!(editor.revision(), Revision(1));
    drop(destination);
    store.refresh_external_changes(&[], &[], &[rename]).unwrap();
    assert_eq!(editor.id(), "new");
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "base");
}

#[test]
fn updated_ids_never_imply_rename_identity() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(4, 4), " draft").unwrap();
    fs::rename(root.0.join("old.md"), root.0.join("old (2).md")).unwrap();
    store
        .refresh_external_changes(&["old (2)".into()], &["old".into()], &[])
        .unwrap();
    assert_eq!(editor.id(), "old");
    assert_eq!(editor.source_text(), "base draft");
}

#[test]
fn portable_pending_completion_after_remote_rename_saves_and_undoes_at_final_id() {
    use futo_notes_editor::{PortableSession, SessionToken};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    let mut host = store
        .open_editor("old")
        .unwrap()
        .into_portable_host(SessionToken(324))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let pending = page.replace(Revision(0), range(4, 4), " draft").unwrap();
    fs::rename(root.0.join("old.md"), root.0.join("final.md")).unwrap();
    let rename = NoteRename {
        from: "old".into(),
        to: "final".into(),
    };
    store.refresh_external_changes(&[], &[], &[rename]).unwrap();
    let ack = host.handle(pending.request.clone());
    page.acknowledge(ack.clone()).unwrap();
    assert_eq!(host.handle(pending.request), ack);
    host.checkpoint().unwrap();
    assert_eq!(host.id(), "final");
    assert_eq!(store.read("final").unwrap(), "base draft");
    let undo = page.undo(Revision(1)).unwrap().unwrap();
    page.acknowledge(host.handle(undo.request)).unwrap();
    host.checkpoint().unwrap();
    assert_eq!(store.read("final").unwrap(), "base");
    assert_eq!(store.read_existing("old").unwrap(), None);
}

#[test]
fn failed_save_after_remote_rename_retains_final_identity_and_retries_merge() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(7, 13), "LOCAL").unwrap();
    fs::rename(root.0.join("old.md"), root.0.join("final.md")).unwrap();
    fs::write(root.0.join("final.md"), "REMOTE\n\nsecond\n").unwrap();
    store
        .refresh_external_changes(
            &[],
            &[],
            &[NoteRename {
                from: "old".into(),
                to: "final".into(),
            }],
        )
        .unwrap();
    let path = root.0.join("final.md");
    let sabotage = path.clone();
    let first = AtomicBool::new(true);
    store.set_flush_window_hook(Box::new(move |_| {
        if first.swap(false, Ordering::SeqCst) {
            fs::remove_file(&sabotage).unwrap();
            fs::create_dir(&sabotage).unwrap();
        }
    }));
    assert!(editor.checkpoint().is_err());
    assert_eq!(editor.id(), "final");
    assert_eq!(editor.source_text(), "first\n\nLOCAL\n");
    assert_eq!(editor.revision(), Revision(1));
    fs::remove_dir(&path).unwrap();
    fs::write(&path, "REMOTE\n\nsecond\n").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read("final").unwrap(), "REMOTE\n\nLOCAL\n");
    assert_eq!(store.read_existing("old").unwrap(), None);
}

#[test]
fn rename_then_delete_in_one_sync_cycle_refreshes_and_keeps_the_draft_attached() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "base").unwrap();
    store.create("", "other", "x").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.replace(Revision(0), range(0, 4), "local").unwrap();
    // The peer renamed the note and a later change in the same cycle deleted it.
    fs::remove_file(root.0.join("old.md")).unwrap();
    fs::write(root.0.join("other.md"), "y").unwrap();
    let rename = NoteRename {
        from: "old".into(),
        to: "gone".into(),
    };
    let mutation = store
        .refresh_external_changes(&["other".into()], &["gone".into()], &[rename])
        .unwrap();
    assert!(mutation.upserted.iter().any(|note| note.note.id == "other"));
    assert_eq!(editor.id(), "old");
    // The draft is never abandoned: saving recreates it (edit wins).
    editor.checkpoint().unwrap();
    assert_eq!(store.read("old").unwrap(), "local");
}

#[test]
fn collision_loser_follows_its_conflict_copy_and_never_merges_into_the_winner() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "note", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("note").unwrap();
    editor.replace(Revision(0), range(7, 13), "LOCAL").unwrap();
    // Sync moved the losing note aside, then wrote the unrelated winner at its id.
    fs::rename(root.0.join("note.md"), root.0.join("note (conflict).md")).unwrap();
    fs::write(root.0.join("note.md"), "first\n\nwinner\n").unwrap();
    let rename = NoteRename {
        from: "note".into(),
        to: "note (conflict)".into(),
    };
    store.refresh_external_changes(&[], &[], &[rename]).unwrap();
    assert_eq!(editor.id(), "note (conflict)");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("note").unwrap(), "first\n\nwinner\n");
    assert_eq!(store.read("note (conflict)").unwrap(), "first\n\nLOCAL\n");
}
