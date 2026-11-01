use super::*;
use futo_notes_editor::{BoundedError, SessionToken};
use storage::{Disk, Fault};

#[test]
fn refused_bounded_entry_keeps_the_same_history_composition_and_lease() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "```Rust\nab\n```\n").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(1, 1), "x").unwrap();
    editor.compose(Revision(1), range(2, 2), "marked").unwrap();
    let before = editor.source_text();
    let selection = editor.selection();
    let error = editor
        .into_bounded(Revision(1), SessionToken(81), DisplayOffset(0))
        .err()
        .unwrap();
    assert_eq!(
        error.error,
        EditorStoreError::Bounded(BoundedError::Editor(
            futo_notes_editor::EditorError::CompositionActive
        ))
    );
    let mut editor = error.session;
    assert_eq!(editor.source_text(), before);
    assert_eq!(editor.selection(), selection);
    assert!(editor.composition().is_some());
    assert!(matches!(
        store.open_editor("plain"),
        Err(EditorStoreError::SessionAlreadyOpen)
    ));
    editor.cancel_composition(Revision(1)).unwrap();
    let bounded = editor
        .into_bounded(Revision(1), SessionToken(81), DisplayOffset(0))
        .unwrap();
    let (mut editor, _) = bounded.into_full().unwrap();
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "```Rust\nab\n```\n");
}

#[test]
fn unsupported_preparation_returns_a_usable_full_owner_and_later_live_log_entry_succeeds() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "```\nab\n```\n").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    let error = editor
        .into_bounded(Revision(0), SessionToken(82), DisplayOffset(0))
        .err()
        .unwrap();
    assert!(matches!(error.error, EditorStoreError::Recovery(_)));
    let mut editor = error.session;
    assert!(!editor.recovery_status().paused);
    assert!(matches!(
        store.open_editor("plain"),
        Err(EditorStoreError::SessionAlreadyOpen)
    ));
    editor.replace(Revision(0), range(0, 0), "x").unwrap();
    let mut bounded = editor
        .into_bounded(Revision(1), SessionToken(82), DisplayOffset(0))
        .unwrap();
    let cursor = bounded.cursor().unwrap();
    bounded
        .insert_literal(cursor, DisplayOffset(1), "y")
        .unwrap();
    assert_eq!(bounded.source_text(), "```\nxyab\n```\n");
}

#[test]
fn failed_entry_flush_preserves_the_original_deadline_and_owner() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "```\nab\n```\n").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let mut editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    editor.replace(Revision(0), range(0, 0), "x").unwrap();
    let before = editor.recovery_status();
    disk.lock().unwrap().fault = Some(Fault::Flush);
    let error = editor
        .into_bounded(Revision(1), SessionToken(83), DisplayOffset(0))
        .err()
        .unwrap();
    assert!(matches!(error.error, EditorStoreError::RecoveryFlush(_)));
    let mut editor = error.session;
    let after = editor.recovery_status();
    assert_eq!(after.flush_deadline, before.flush_deadline);
    assert_eq!(after.accepted, before.accepted);
    assert_eq!(after.durable, before.durable);
    assert_eq!(editor.source_text(), "```\nxab\n```\n");
    assert!(after.paused);
    disk.lock().unwrap().fault = None;
    editor.resume_recovery().unwrap();
    assert!(editor
        .into_bounded(Revision(1), SessionToken(83), DisplayOffset(0))
        .is_ok());
}

#[test]
fn failed_registry_identity_work_cannot_restore_old_bounded_coordinates() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "```\nab\n```\n").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let mut editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    editor.replace(Revision(0), range(0, 0), "x").unwrap();
    let mut bounded = editor
        .into_bounded(Revision(1), SessionToken(84), DisplayOffset(0))
        .unwrap();
    let old = bounded.cursor().unwrap();
    disk.lock().unwrap().fault = Some(Fault::Create);
    assert!(store.rename("plain", "renamed").is_err());
    assert!(bounded.reset_required());
    assert_eq!(
        bounded.insert_literal(old, DisplayOffset(1), "z"),
        Err(EditorStoreError::ModeResetRequired)
    );
    assert_eq!(bounded.source_text(), "```\nxab\n```\n");
    disk.lock().unwrap().fault = None;
    let (mut editor, _) = bounded.into_full().unwrap();
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "```\nab\n```\n");
    assert!(matches!(
        store.open_editor("plain"),
        Err(EditorStoreError::SessionAlreadyOpen)
    ));
}
