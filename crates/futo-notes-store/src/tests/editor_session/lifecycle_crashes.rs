use super::*;
use std::path::Path;

struct CrashStorage {
    inner: Box<dyn RecoveryStorage>,
    phase: String,
}
impl CrashStorage {
    fn interrupt(&self, operation: &str, path: &str) {
        let destination = format!(
            ".futo-editor-recovery/{}.jsonl",
            futo_notes_core::hash::hash_sha256("new")
        );
        let crash = match self.phase.as_str() {
            "prepared" => operation == "flush" && path.ends_with(".retarget"),
            "moved" => operation == "before-create" && path.ends_with(".retarget.committed"),
            "decision" => operation == "flush" && path.ends_with(".retarget.committed"),
            "new-stream" => operation == "flush" && path == destination,
            "old-retired" => operation == "remove" && path.ends_with(".jsonl"),
            "intent-retired" => operation == "remove" && path.ends_with(".retarget"),
            "decision-retired" => operation == "remove" && path.ends_with(".retarget.committed"),
            "delete-decision" => operation == "flush" && path.ends_with(".delete.committed"),
            "delete-stream-retired" => operation == "remove" && path.ends_with(".jsonl"),
            "pending-delete-decision" => {
                operation == "flush" && path.ends_with(".delete.committed")
            }
            "pending-delete-artifact-retired" => {
                operation == "remove" && path.ends_with(".retarget")
            }
            "relink-prepared" => operation == "flush" && path.ends_with(".retarget"),
            "relink-decision" => operation == "flush" && path.ends_with(".retarget.committed"),
            "relink-before-snapshot" => operation == "before-replace" && path.ends_with(".jsonl"),
            "relink-snapshot" => operation == "flush" && path.ends_with(".jsonl"),
            "relink-intent-retired" => operation == "remove" && path.ends_with(".retarget"),
            "relink-decision-retired" => {
                operation == "remove" && path.ends_with(".retarget.committed")
            }
            _ => false,
        };
        if crash {
            std::process::exit(74);
        }
    }
}
impl RecoveryStorage for CrashStorage {
    fn list(&mut self, root: &Path) -> Result<Vec<String>, String> {
        self.inner.list(root)
    }
    fn read(&mut self, root: &Path, path: &str) -> Result<Option<Vec<u8>>, String> {
        self.inner.read(root, path)
    }
    fn create(&mut self, root: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        if self.phase.starts_with("pending-delete-") && path.ends_with(".retarget.committed") {
            return Err("interrupted rename recovery".into());
        }
        self.interrupt("before-create", path);
        self.inner.create(root, path, bytes)
    }
    fn replace(&mut self, root: &std::path::Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.interrupt("before-replace", path);
        self.inner.replace(root, path, bytes)
    }
    fn append(&mut self, root: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.inner.append(root, path, bytes)
    }
    fn truncate(&mut self, root: &Path, path: &str, length: u64) -> Result<(), String> {
        self.inner.truncate(root, path, length)
    }
    fn flush(&mut self, root: &Path, path: &str) -> Result<(), String> {
        self.inner.flush(root, path)?;
        self.interrupt("flush", path);
        Ok(())
    }
    fn remove(&mut self, root: &Path, path: &str) -> Result<(), String> {
        self.inner.remove(root, path)?;
        self.interrupt("remove", path);
        Ok(())
    }
}
fn child(root: &Path, phase: &str) {
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::editor_session::lifecycle_crashes::identity_death_child",
            "--nocapture",
        ])
        .env("FUTO_EDITOR_IDENTITY_VAULT", root)
        .env("FUTO_EDITOR_IDENTITY_PHASE", phase)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(74), "{phase}");
}
#[test]
fn identity_recovery_discovers_the_moved_draft_after_each_durable_boundary() {
    for phase in [
        "prepared",
        "moved",
        "decision",
        "new-stream",
        "old-retired",
        "intent-retired",
        "decision-retired",
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "old", "__日__\r\n").unwrap();
        child(&root.0, phase);
        let id = if phase == "prepared" { "old" } else { "new" };
        let mut editor = store.open_editor(id).unwrap();
        assert_eq!(editor.source_text(), "__日😀__\r\n", "{phase}");
        assert_eq!(editor.revision(), Revision(1));
        editor.checkpoint().unwrap();
        drop(editor);
        for _ in 0..2 {
            assert_eq!(store.open_editor(id).unwrap().source_text(), "__日😀__\r\n");
            assert_eq!(store.snapshot().notes.len(), 1);
        }
    }
}
#[test]
fn deletion_recovery_distinguishes_prepared_rollback_from_committed_finality() {
    for phase in [
        "delete-prepared",
        "delete-decision",
        "delete-stream-retired",
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "old", "__日__\r\n").unwrap();
        child(&root.0, phase);
        if phase == "delete-prepared" {
            let mut recovered = store.open_editor("old").unwrap();
            assert_eq!(recovered.source_text(), "__日😀__\r\n");
            recovered.checkpoint().unwrap();
        } else {
            store.create("", "old", "new incarnation").unwrap();
            let mut current = store.open_editor("old").unwrap();
            assert_eq!(current.source_text(), "new incarnation");
            assert!(current.checkpoint().unwrap().mutation.is_none());
        }
        assert_eq!(store.snapshot().notes.len(), 1);
    }
}
#[test]
fn process_death_during_delete_of_pending_destination_never_replays_deleted_incarnation() {
    for phase in [
        "pending-delete-prepared",
        "pending-delete-decision",
        "pending-delete-artifact-retired",
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "old", "__日__\r\n").unwrap();
        child(&root.0, phase);
        if phase == "pending-delete-prepared" {
            let mut current = store.open_editor("new").unwrap();
            assert_eq!(current.source_text(), "__日😀__\r\n");
            current.checkpoint().unwrap();
        } else {
            store.create("", "new", "new incarnation").unwrap();
            for _ in 0..2 {
                assert!(store.open_editor("old").is_err());
                let mut current = store.open_editor("new").unwrap();
                assert_eq!(current.source_text(), "new incarnation", "{phase}");
                current.checkpoint().unwrap();
            }
        }
        assert_eq!(store.read_existing("old").unwrap(), None);
        assert_eq!(store.snapshot().notes.len(), 1);
    }
}

#[test]
fn process_death_during_same_id_relink_preserves_the_exact_committed_source() {
    for phase in [
        "relink-prepared",
        "relink-decision",
        "relink-before-snapshot",
        "relink-snapshot",
        "relink-intent-retired",
        "relink-decision-retired",
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "old", "target").unwrap();
        store.create("", "plain", "[[old]]").unwrap();
        child(&root.0, phase);
        let (source, revision, target) = if phase == "relink-prepared" {
            ("[[old]]", Revision(2), "old")
        } else {
            ("[[new]]", Revision(3), "new")
        };
        let mut editor = store.open_editor("plain").unwrap();
        assert_eq!(editor.source_text(), source, "{phase}");
        assert_eq!(editor.revision(), revision, "{phase}");
        assert_eq!(editor.recovery_issue(), None, "{phase}");
        assert!(editor.undo(revision).unwrap().is_none());
        editor.checkpoint().unwrap();
        drop(editor);
        for _ in 0..2 {
            let mut editor = store.open_editor("plain").unwrap();
            assert_eq!(editor.source_text(), source, "{phase}");
            editor.checkpoint().unwrap();
            assert_eq!(store.read("plain").unwrap(), source);
            assert_eq!(store.read(target).unwrap(), "target");
            assert_eq!(store.snapshot().notes.len(), 2);
        }
    }
}
#[test]
fn identity_death_child() {
    let Some(root) = std::env::var_os("FUTO_EDITOR_IDENTITY_VAULT") else {
        return;
    };
    let phase = std::env::var("FUTO_EDITOR_IDENTITY_PHASE").unwrap();
    let store = LocalNoteStore::new(root.into());
    if phase.starts_with("relink-") {
        let defaults = RecoveryOptions::default();
        let mut editor = store
            .open_editor_with_recovery(
                "plain",
                RecoveryOptions {
                    clock: defaults.clock,
                    storage: Box::new(CrashStorage {
                        inner: defaults.storage,
                        phase: phase.clone(),
                    }),
                },
            )
            .unwrap();
        editor.replace(Revision(0), range(7, 7), "!").unwrap();
        editor.undo(Revision(1)).unwrap().unwrap();
        store.rename("old", "new").unwrap();
        panic!("relink interruption did not fire: {phase}");
    }
    let defaults = RecoveryOptions::default();
    let mut editor = store
        .open_editor_with_recovery(
            "old",
            RecoveryOptions {
                clock: defaults.clock,
                storage: Box::new(CrashStorage {
                    inner: defaults.storage,
                    phase: phase.clone(),
                }),
            },
        )
        .unwrap();
    editor.replace(Revision(0), range(3, 3), "😀").unwrap();
    if phase.starts_with("pending-delete-") {
        store.rename("old", "new").unwrap();
        assert!(editor.recovery_status().paused);
        if phase == "pending-delete-prepared" {
            store
                .delete_with("new", |path| {
                    std::fs::remove_file(path).unwrap();
                    std::process::exit(74);
                })
                .unwrap();
        } else {
            store.delete("new").unwrap();
        }
    } else if phase == "delete-prepared" {
        store
            .delete_with("old", |path| {
                std::fs::remove_file(path).unwrap();
                std::process::exit(74);
            })
            .unwrap();
    } else if phase.starts_with("delete-") {
        store.delete("old").unwrap();
    } else {
        store.rename("old", "new").unwrap();
    }
    panic!("identity interruption did not fire: {phase}");
}
