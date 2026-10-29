use super::*;
use futo_notes_editor::InputAction;
use storage::{Disk, Fault};

struct FailAfterRename(Arc<Mutex<Disk>>, Fault);
impl BeforeWrite for FailAfterRename {
    fn before_write(&self, changes: &[FileChange]) {
        if changes
            .iter()
            .any(|change| matches!(change, FileChange::Renamed { .. }))
        {
            self.0.lock().unwrap().fault = Some(self.1);
        }
    }
}

#[test]
fn relink_recovery_failures_keep_history_and_survive_repeated_power_loss() {
    for fault in [
        Fault::Create,
        Fault::Flush,
        Fault::Retire,
        Fault::RetireSync,
    ] {
        let root = TestRoot::new();
        let disk = Arc::new(Mutex::new(Disk::default()));
        let store = LocalNoteStore::with_before_write(
            root.0.clone(),
            Arc::new(FailAfterRename(disk.clone(), fault)),
        );
        store.create("", "old", "target").unwrap();
        store.create("", "plain", "[[old]]").unwrap();
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        editor
            .replace_action(Revision(0), range(7, 7), "!", InputAction::Isolated)
            .unwrap();
        editor.checkpoint().unwrap();
        let result = store.rename("old", "long name").unwrap();
        assert_eq!(result.relinked, ["plain"]);
        assert_eq!(store.read("plain").unwrap(), "[[long name]]!");
        assert!(editor.recovery_status().paused);
        assert!(editor.replace(editor.revision(), range(0, 0), "?").is_err());
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        assert_eq!(editor.source_text(), "[[long name]]!");
        assert_eq!(editor.revision(), Revision(2));
        editor.undo(Revision(2)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "[[long name]]");
        editor.redo(Revision(3)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "[[long name]]!");
        editor.flush_recovery().unwrap();
        drop(editor);
        for _ in 0..2 {
            disk.lock().unwrap().power_loss();
            let mut recovered = store
                .open_editor_with_recovery("plain", storage::options(&disk))
                .unwrap();
            assert_eq!(recovered.source_text(), "[[long name]]!");
            assert!(recovered.undo(recovered.revision()).unwrap().is_none());
            recovered.flush_recovery().unwrap();
        }
        assert_eq!(store.read_existing("old").unwrap(), None);
        assert_eq!(store.read("long name").unwrap(), "target");
        assert_eq!(store.snapshot().notes.len(), 2);
    }
}

struct BlockBacklink(std::path::PathBuf);
impl BeforeWrite for BlockBacklink {
    fn before_write(&self, changes: &[FileChange]) {
        if changes
            .iter()
            .any(|change| matches!(change, FileChange::Renamed { .. }))
        {
            // A deterministic outside filesystem change blocks only the
            // best-effort backlink install, after identity preparation.
            fs::rename(self.0.join("plain.md"), self.0.join("original")).unwrap();
            fs::create_dir(self.0.join("plain.md")).unwrap();
        }
    }
}

#[test]
fn failed_backlink_install_preserves_exact_live_source_selection_and_preexisting_redo() {
    let root = TestRoot::new();
    let store =
        LocalNoteStore::with_before_write(root.0.clone(), Arc::new(BlockBacklink(root.0.clone())));
    store.create("", "old", "target").unwrap();
    store.create("", "plain", "[[old]]").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    editor
        .replace_action(Revision(0), range(7, 7), "!", InputAction::Isolated)
        .unwrap();
    editor.undo(Revision(1)).unwrap().unwrap();
    editor.checkpoint().unwrap();
    let mutation = store.rename("old", "long name").unwrap();
    assert!(mutation.relinked.is_empty());
    assert!(!mutation.warnings.is_empty());
    assert_eq!(editor.source_text(), "[[old]]");
    assert_eq!(editor.selection(), range(0, 0));
    assert_eq!(editor.revision(), Revision(2));
    assert!(editor.recovery_status().paused);
    fs::remove_dir(root.0.join("plain.md")).unwrap();
    fs::rename(root.0.join("original"), root.0.join("plain.md")).unwrap();
    editor.resume_recovery().unwrap();
    assert!(editor.take_coordinated_changes().unwrap().is_empty());
    editor.redo(Revision(2)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[old]]!");
    assert_eq!(editor.selection(), range(8, 8));
    editor.undo(Revision(3)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[old]]");
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "[[old]]");
    assert_eq!(store.read("long name").unwrap(), "target");
}

#[test]
fn power_loss_while_same_id_relink_is_pending_recovers_the_durable_action_once() {
    for fault in [
        Fault::Create,
        Fault::Flush,
        Fault::Retire,
        Fault::RetireSync,
    ] {
        let root = TestRoot::new();
        let disk = Arc::new(Mutex::new(Disk::default()));
        let store = LocalNoteStore::with_before_write(
            root.0.clone(),
            Arc::new(FailAfterRename(disk.clone(), fault)),
        );
        store.create("", "old", "target").unwrap();
        store.create("", "plain", "[[old]]").unwrap();
        {
            let mut editor = store
                .open_editor_with_recovery("plain", storage::options(&disk))
                .unwrap();
            editor.replace(Revision(0), range(7, 7), "!").unwrap();
            editor.undo(Revision(1)).unwrap().unwrap();
            store.rename("old", "long name").unwrap();
            assert!(editor.recovery_status().paused);
        }
        // Interrupt before a live resume can repair the failed boundary.
        // Only successful storage flushes survive this recovery-disk model.
        disk.lock().unwrap().power_loss();
        disk.lock().unwrap().fault = None;
        for _ in 0..2 {
            let mut editor = store
                .open_editor_with_recovery("plain", storage::options(&disk))
                .unwrap();
            assert_eq!(editor.source_text(), "[[long name]]");
            assert_eq!(editor.revision(), Revision(3));
            assert_eq!(editor.recovery_issue(), None);
            editor.flush_recovery().unwrap();
            drop(editor);
            disk.lock().unwrap().power_loss();
        }
        assert_eq!(store.read("plain").unwrap(), "[[long name]]");
        assert_eq!(store.read_existing("old").unwrap(), None);
        assert_eq!(store.read("long name").unwrap(), "target");
        assert_eq!(store.snapshot().notes.len(), 2);
    }
}
