//! Merge adoption through the public attached editor save workflow.
use super::*;
use std::sync::atomic::Ordering;

#[test]
fn checkpoint_combines_independent_paragraphs_and_undo_keeps_the_peer() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(7, 13), "LOCAL").unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(editor.id(), "plain");
    assert_eq!(editor.source_text(), "REMOTE\n\nLOCAL\n");
    assert_eq!(store.read("plain").unwrap(), "REMOTE\n\nLOCAL\n");
    assert_eq!(editor.take_coordinated_changes().unwrap().len(), 1);
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\nsecond\n");
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\nLOCAL\n");
}

#[test]
fn merge_preserves_unicode_selection_multiple_undo_steps_and_redo() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "one\n\n猫 second\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor
        .replace_action(
            Revision(0),
            range(16, 16),
            "!",
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    editor
        .replace_action(
            Revision(1),
            range(17, 17),
            "?",
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    editor
        .select_with_affinity(
            Revision(2),
            range(5, 8),
            futo_notes_editor::Affinity::Forward,
        )
        .unwrap();
    store.write("plain", "日本🦀\n\n猫 second\n", None).unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(editor.source_text(), "日本🦀\n\n猫 second\n!?");
    assert_eq!(editor.selection(), range(12, 15));
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "日本🦀\n\n猫 second\n!");
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "日本🦀\n\n猫 second\n");
    assert!(editor.undo(editor.revision()).unwrap().is_none());
    editor.redo(editor.revision()).unwrap().unwrap();
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "日本🦀\n\n猫 second\n!?");
}

#[test]
fn checkpoint_settles_marked_text_before_merge_and_undo_keeps_remote_source() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "one\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.compose(Revision(0), range(5, 11), "日本").unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\n日本\n");
    assert!(editor.composition().is_none());
    assert_eq!(editor.take_coordinated_changes().unwrap().len(), 2);
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\nsecond\n");
}

#[test]
fn failed_merged_write_keeps_source_history_and_baseline_for_retry() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "one\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(5, 11), "LOCAL").unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    let path = root.0.join("plain.md");
    let sabotage = path.clone();
    let first = std::sync::atomic::AtomicBool::new(true);
    store.set_flush_window_hook(Box::new(move |_| {
        if first.swap(false, Ordering::SeqCst) {
            std::fs::remove_file(&sabotage).unwrap();
            std::fs::create_dir(&sabotage).unwrap();
        }
    }));
    assert!(editor.checkpoint().is_err());
    assert_eq!(editor.source_text(), "one\n\nLOCAL\n");
    assert_eq!(editor.revision(), Revision(1));
    assert!(editor.take_coordinated_changes().unwrap().is_empty());
    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, "REMOTE\n\nsecond\n").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\nLOCAL\n");
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\nsecond\n");
}

#[test]
fn ordinary_checkpoint_saves_committed_typing_without_settling_the_ime() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "one\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(0, 3), "LOCAL").unwrap();
    editor.compose(Revision(1), range(7, 13), "日本").unwrap();
    let marked = editor.composition();
    editor.checkpoint().unwrap();
    assert_eq!(editor.source_text(), "LOCAL\n\nsecond\n");
    assert_eq!(store.read("plain").unwrap(), "LOCAL\n\nsecond\n");
    assert_eq!(editor.composition(), marked);
    assert_eq!(editor.revision(), Revision(1));
    assert!(editor.take_coordinated_changes().unwrap().is_empty());
}

#[test]
fn a_twenty_thousand_line_note_keeps_a_representative_local_history_after_merge() {
    let root = TestRoot::new();
    let store = store(&root);
    let base = format!("first\n\n{}\nlast", "x\n".repeat(20_000));
    store.create("", "plain", &base).unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    for step in 0..32 {
        let at = base.len() + step;
        editor
            .replace_action(
                editor.revision(),
                range(at, at),
                "!",
                futo_notes_editor::InputAction::Isolated,
            )
            .unwrap();
    }
    let remote = base.replacen("first", "REMOTE", 1);
    store.write("plain", &remote, None).unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(editor.id(), "plain");
    assert_eq!(editor.source_text(), format!("{remote}{}", "!".repeat(32)));
    for _ in 0..32 {
        editor.undo(editor.revision()).unwrap().unwrap();
    }
    assert_eq!(editor.source_text(), remote);
}

#[test]
fn oversized_merge_preflight_parks_without_changing_or_dropping_local_history() {
    let root = TestRoot::new();
    let store = store(&root);
    let base = format!("first\n\n{}", "x".repeat(1024 * 1024));
    store.create("", "plain", &base).unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor
        .replace(Revision(0), range(base.len(), base.len()), "!")
        .unwrap();
    let remote = base.replacen("first", "REMOTE", 1);
    store.write("plain", &remote, None).unwrap();
    let result = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = result.disposition else {
        panic!("unbounded preflight must preserve both versions")
    };
    assert_eq!(store.read("plain").unwrap(), remote);
    assert_eq!(store.read(&parked_id).unwrap(), format!("{base}!"));
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), base);
}

#[test]
fn merge_rebases_a_redo_stack_that_already_exists_before_saving() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor
        .replace_action(
            Revision(0),
            range(7, 13),
            "LOCAL",
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    editor
        .replace_action(
            Revision(1),
            range(13, 13),
            "!",
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    editor.undo(Revision(2)).unwrap().unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\nLOCAL\n");
    editor.redo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\nLOCAL\n!");
    editor.undo(editor.revision()).unwrap().unwrap();
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "REMOTE\n\nsecond\n");
}

#[test]
fn ambiguous_older_history_parks_both_versions_instead_of_erasing_the_peer_on_undo() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor
        .replace_action(
            Revision(0),
            range(0, 5),
            "saved",
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    editor.checkpoint().unwrap();
    editor
        .replace_action(
            Revision(1),
            range(7, 13),
            "LOCAL",
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    let result = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = result.disposition else {
        panic!("ambiguous retained Undo must preserve both versions")
    };
    assert_eq!(store.read("plain").unwrap(), "REMOTE\n\nsecond\n");
    assert_eq!(store.read(&parked_id).unwrap(), "saved\n\nLOCAL\n");
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "saved\n\nsecond\n");
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "first\n\nsecond\n");
}

#[test]
fn clean_checkpoint_adopts_peer_source_and_undo_keeps_the_peer() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(0, 0), "local ").unwrap();
    editor.checkpoint().unwrap();
    editor
        .select_with_affinity(
            editor.revision(),
            range(6, 11),
            futo_notes_editor::Affinity::Forward,
        )
        .unwrap();
    store
        .write("plain", "local first\n\npeer second\n", None)
        .unwrap();
    let result = editor.checkpoint().unwrap();
    assert_eq!(result.disposition, FlushDisposition::Converged);
    assert!(result.mutation.is_none());
    assert_eq!(editor.id(), "plain");
    assert_eq!(editor.source_text(), "local first\n\npeer second\n");
    assert_eq!(editor.selection(), range(6, 11));
    assert_eq!(editor.take_coordinated_changes().unwrap().len(), 1);
    assert_eq!(editor.save_status().saved, editor.revision());
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "first\n\npeer second\n");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "first\n\npeer second\n");
}

#[test]
fn clean_checkpoint_does_not_recreate_a_peer_deleted_note() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(0, 0), "local ").unwrap();
    editor.checkpoint().unwrap();
    std::fs::remove_file(root.0.join("plain.md")).unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Converged
    );
    assert_eq!(store.read_existing("plain").unwrap(), None);
    assert_eq!(editor.source_text(), "local first\n\nsecond\n");
    assert!(editor.take_coordinated_changes().unwrap().is_empty());
    // A subsequent real edit still has the existing edit-wins promise.
    editor.replace(editor.revision(), range(6, 6), "!").unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Recreated
    );
    assert_eq!(store.read("plain").unwrap(), "local !first\n\nsecond\n");
}

#[test]
fn clean_refresh_read_failure_keeps_source_history_and_baseline_for_retry() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(0, 0), "local ").unwrap();
    editor.checkpoint().unwrap();
    let saved = editor.save_status().saved;
    let path = root.0.join("plain.md");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(editor.checkpoint().is_err());
    assert_eq!(editor.source_text(), "local first\n\nsecond\n");
    assert_eq!(editor.save_status().saved, saved);
    assert!(editor.save_delay().is_some());
    assert!(editor.take_coordinated_changes().unwrap().is_empty());
    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, "local first\n\npeer second\n").unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(editor.source_text(), "local first\n\npeer second\n");
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "first\n\npeer second\n");
}

#[test]
fn clean_refresh_with_ambiguous_saved_undo_preserves_both_versions() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(0, 5), "saved").unwrap();
    editor.checkpoint().unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    let result = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = result.disposition else {
        panic!("ambiguous saved Undo must preserve both versions")
    };
    assert_eq!(editor.id(), parked_id);
    assert_eq!(store.read("plain").unwrap(), "REMOTE\n\nsecond\n");
    assert_eq!(store.read(&parked_id).unwrap(), "saved\n\nsecond\n");
    editor.undo(editor.revision()).unwrap().unwrap();
    assert_eq!(editor.source_text(), "first\n\nsecond\n");
}

#[test]
fn portable_clean_checkpoint_leaves_page_owned_source_and_history_unchanged() {
    use futo_notes_editor::{PortableSession, SessionToken};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(325))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let edit = page.replace(Revision(0), range(0, 0), "local ").unwrap();
    page.acknowledge(host.handle(edit.request)).unwrap();
    host.checkpoint().unwrap();
    store
        .write("plain", "local first\n\npeer second\n", None)
        .unwrap();
    assert_eq!(
        host.checkpoint().unwrap().disposition,
        FlushDisposition::Converged
    );
    assert_eq!(host.snapshot().source, "local first\n\nsecond\n");
    assert_eq!(page.draft_text(), "local first\n\nsecond\n");
    let undo = page.undo(Revision(1)).unwrap().unwrap();
    page.acknowledge(host.handle(undo.request)).unwrap();
    assert_eq!(page.draft_text(), "first\n\nsecond\n");
    assert_eq!(store.read("plain").unwrap(), "local first\n\npeer second\n");
}
