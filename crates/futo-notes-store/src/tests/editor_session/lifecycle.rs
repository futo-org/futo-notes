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
