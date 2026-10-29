use super::*;
use storage::{Disk, Fault};

struct FailDestination(Arc<Mutex<Disk>>);
impl BeforeWrite for FailDestination {
    fn before_write(&self, changes: &[FileChange]) {
        if changes
            .iter()
            .any(|change| matches!(change, FileChange::Renamed { .. }))
        {
            self.0.lock().unwrap().fault = Some(Fault::Create);
        }
    }
}

struct OccupyDestination(std::path::PathBuf);
impl BeforeWrite for OccupyDestination {
    fn before_write(&self, changes: &[FileChange]) {
        if changes
            .iter()
            .any(|change| matches!(change, FileChange::Renamed { .. }))
        {
            // This hook is an external filesystem input below the workflow.
            std::fs::write(self.0.join("new.md"), "external").unwrap();
        }
    }
}

#[test]
fn failed_rename_cannot_replay_its_preparation_over_later_backlink_input() {
    let root = TestRoot::new();
    let store = LocalNoteStore::with_before_write(
        root.0.clone(),
        Arc::new(OccupyDestination(root.0.clone())),
    );
    store.create("", "old", "target").unwrap();
    store.create("", "plain", "[[old]]").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor.replace(Revision(0), range(7, 7), "!").unwrap();
    assert!(store.rename("old", "new").is_err());
    editor.replace(Revision(1), range(8, 8), "?").unwrap();
    drop(editor);
    let mut reopened = store.open_editor("plain").unwrap();
    assert_eq!(reopened.source_text(), "[[old]]!?");
    reopened.checkpoint().unwrap();
    assert_eq!(store.read("old").unwrap(), "target");
    assert_eq!(store.read("new").unwrap(), "external");
    assert_eq!(store.read("plain").unwrap(), "[[old]]!?");
}

#[test]
fn failed_delete_rollback_cleanup_pauses_then_resumes_the_same_draft() {
    let root = TestRoot::new();
    let store = store(&root);
    let disk = Arc::new(Mutex::new(Disk::default()));
    store.create("", "old", "old").unwrap();
    let mut editor = store
        .open_editor_with_recovery("old", storage::options(&disk))
        .unwrap();
    editor.replace(Revision(0), range(3, 3), " draft").unwrap();
    assert!(store
        .delete_with("old", |path| {
            std::fs::remove_file(path).unwrap();
            disk.lock().unwrap().fault = Some(Fault::Retire);
            Err("delete failed after removal".into())
        })
        .is_err());
    assert!(editor.recovery_status().paused);
    assert_eq!(editor.source_text(), "old draft");
    disk.lock().unwrap().fault = None;
    editor.resume_recovery().unwrap();
    editor.replace(Revision(1), range(9, 9), "!").unwrap();
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("old").unwrap(), "old draft!");
    drop(editor);
    let mut editor = store
        .open_editor_with_recovery("old", storage::options(&disk))
        .unwrap();
    assert_eq!(editor.source_text(), "old draft!");
    editor.checkpoint().unwrap();
    assert_eq!(store.snapshot().notes.len(), 1);
}

#[test]
fn committed_rename_failure_blocks_input_and_retries_without_losing_history() {
    let root = TestRoot::new();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let store =
        LocalNoteStore::with_before_write(root.0.clone(), Arc::new(FailDestination(disk.clone())));
    store.create("", "old", "old").unwrap();
    let mut editor = store
        .open_editor_with_recovery("old", storage::options(&disk))
        .unwrap();
    editor.replace(Revision(0), range(3, 3), " draft").unwrap();
    let mutation = store.rename("old", "new").unwrap();
    assert_eq!(mutation.final_id.as_deref(), Some("new"));
    assert_eq!(editor.source_text(), "old draft");
    assert!(editor.recovery_status().paused);
    assert!(editor.replace(Revision(1), range(9, 9), "!").is_err());
    disk.lock().unwrap().fault = None;
    editor.resume_recovery().unwrap();
    assert_eq!(editor.id(), "new");
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "old");
    editor.redo(Revision(2)).unwrap().unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read_existing("old").unwrap(), None);
    assert_eq!(store.read("new").unwrap(), "old draft");
}

#[test]
fn deleting_pending_rename_destination_fences_old_owner_and_recovery() {
    for destination in ["new", "OLD", "folder/new"] {
        let root = TestRoot::new();
        let disk = Arc::new(Mutex::new(Disk::default()));
        let store = LocalNoteStore::with_before_write(
            root.0.clone(),
            Arc::new(FailDestination(disk.clone())),
        );
        store.create("", "old", "old").unwrap();
        let mut editor = store
            .open_editor_with_recovery("old", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(3, 3), " draft").unwrap();
        store.rename("old", destination).unwrap();
        assert!(editor.recovery_status().paused);
        disk.lock().unwrap().fault = None;
        assert!(store.rename(destination, "chain").is_err());
        if destination.starts_with("folder/") {
            assert!(store.delete_folder("folder").is_err());
        }
        store.delete(destination).unwrap();
        let (folder, title) = destination.rsplit_once('/').unwrap_or(("", destination));
        store.create(folder, title, "new incarnation").unwrap();
        assert_eq!(
            editor.resume_recovery(),
            Err(EditorStoreError::SessionDeleted)
        );
        assert_eq!(editor.checkpoint(), Err(EditorStoreError::SessionDeleted));
        assert_eq!(
            editor.replace(Revision(1), range(9, 9), "!"),
            Err(EditorStoreError::SessionDeleted)
        );
        drop(editor);
        for _ in 0..2 {
            if destination == "OLD" {
                if let Ok(alias) = store.open_editor_with_recovery("old", storage::options(&disk)) {
                    assert_eq!(alias.source_text(), "new incarnation");
                }
            } else {
                assert!(store
                    .open_editor_with_recovery("old", storage::options(&disk))
                    .is_err());
            }
            let mut current = store
                .open_editor_with_recovery(destination, storage::options(&disk))
                .unwrap();
            assert_eq!(current.source_text(), "new incarnation");
            current.checkpoint().unwrap();
            assert_eq!(
                store
                    .snapshot()
                    .notes
                    .iter()
                    .map(|note| note.id.as_str())
                    .collect::<Vec<_>>(),
                [destination]
            );
            assert_eq!(store.read(destination).unwrap(), "new incarnation");
            assert_eq!(store.snapshot().notes.len(), 1);
        }
    }
}
