use super::fixtures::alter_frame;
use super::*;

#[test]
fn checkpoint_cannot_install_markdown_before_its_recovery_target_is_durable() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let mut editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    disk.lock().unwrap().fault = Some(Fault::Flush);
    assert!(matches!(
        editor.checkpoint(),
        Err(EditorStoreError::Checkpoint(_))
    ));
    assert_eq!(store.read("plain").unwrap(), "plain");
    assert_eq!(editor.source_text(), "plain!");
    assert!(editor.recovery_status().paused);
    disk.lock().unwrap().fault = None;
    editor.resume_recovery().unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "plain!");
}

// Test files are inputs to the public storage seam. Re-sealing a deliberately
// changed fixture models a valid older stream, rather than accidental bit rot.
#[test]
fn interrupted_park_recovery_reuses_its_recorded_target_even_after_the_date_changed() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let parked;
    {
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
        store.write("plain", "peer", None).unwrap();
        disk.lock().unwrap().fault = Some(Fault::Retire);
        let Err(EditorStoreError::CheckpointCommitted { result, .. }) = editor.checkpoint() else {
            panic!("expected interrupted retirement")
        };
        let FlushDisposition::ParkedConflict { parked_id } = result.disposition else {
            panic!("must park")
        };
        parked = parked_id;
    }
    // Model the same durable install and log from an earlier calendar day.
    store
        .rename(&parked, "plain (conflict 2000-01-01)")
        .unwrap();
    {
        let mut disk = disk.lock().unwrap();
        disk.fault = None;
        alter_frame(disk.accepted.values_mut().next().unwrap(), 2, |payload| {
            payload["Checkpoint"]["id"] = "plain (conflict 2000-01-01)".into();
        });
    }
    for _ in 0..2 {
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        assert_eq!(editor.source_text(), "plain!");
        assert!(editor.recovery_status().paused);
        disk.lock().unwrap().fault = Some(Fault::Retire);
        let Err(EditorStoreError::CheckpointCommitted { result, .. }) = editor.checkpoint() else {
            panic!("expected retryable retirement")
        };
        assert_eq!(
            result.disposition,
            FlushDisposition::ParkedConflict {
                parked_id: "plain (conflict 2000-01-01)".into()
            }
        );
        assert_eq!(
            result.mutation.unwrap().final_id.as_deref(),
            Some("plain (conflict 2000-01-01)")
        );
        disk.lock().unwrap().fault = None;
        assert_eq!(store.snapshot().notes.len(), 2);
    }
    let mut editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    editor.checkpoint().unwrap();
    assert_eq!(editor.id(), "plain (conflict 2000-01-01)");
    assert_eq!(store.read("plain").unwrap(), "peer");
    assert_eq!(store.read(&editor.id()).unwrap(), "plain!");
    assert_eq!(store.snapshot().notes.len(), 2);
}

#[test]
fn process_death_around_checkpoint_install_and_retirement_is_idempotent() {
    for phase in ["before-install", "before-retirement", "after-retirement"] {
        for conflict in [false, true] {
            let root = TestRoot::new();
            let store = store(&root);
            store.create("", "plain", "plain").unwrap();
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::editor_session::recovery::checkpoint::checkpoint_death_child",
                    "--nocapture",
                ])
                .env("FUTO_EDITOR_CHECKPOINT_VAULT", &root.0)
                .env("FUTO_EDITOR_CHECKPOINT_PHASE", phase)
                .env(
                    "FUTO_EDITOR_CHECKPOINT_CONFLICT",
                    if conflict { "yes" } else { "no" },
                )
                .status()
                .unwrap();
            assert_eq!(status.code(), Some(74), "{phase}, conflict={conflict}");
            let mut editor = store.open_editor("plain").unwrap();
            if phase != "after-retirement" {
                assert_eq!(editor.source_text(), "plain!");
                assert_eq!(editor.revision(), Revision(1));
            }
            editor.checkpoint().unwrap();
            drop(editor);
            for _ in 0..2 {
                store.open_editor("plain").unwrap().checkpoint().unwrap();
                let mut contents: Vec<String> = store
                    .snapshot()
                    .notes
                    .iter()
                    .map(|note| store.read(&note.id).unwrap())
                    .collect();
                contents.sort();
                assert_eq!(
                    contents,
                    if conflict {
                        vec!["peer", "plain!"]
                    } else {
                        vec!["plain!"]
                    },
                    "{phase}"
                );
            }
        }
    }
}

struct CrashStorage {
    inner: Box<dyn RecoveryStorage>,
    phase: String,
}

impl RecoveryStorage for CrashStorage {
    fn read(&mut self, root: &std::path::Path, path: &str) -> Result<Option<Vec<u8>>, String> {
        self.inner.read(root, path)
    }
    fn create(&mut self, root: &std::path::Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.inner.create(root, path, bytes)
    }
    fn replace(&mut self, root: &std::path::Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.inner.replace(root, path, bytes)
    }
    fn append(&mut self, root: &std::path::Path, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.inner.append(root, path, bytes)
    }
    fn truncate(&mut self, root: &std::path::Path, path: &str, length: u64) -> Result<(), String> {
        self.inner.truncate(root, path, length)
    }
    fn flush(&mut self, root: &std::path::Path, path: &str) -> Result<(), String> {
        self.inner.flush(root, path)?;
        if self.phase == "before-install" {
            std::process::exit(74);
        }
        Ok(())
    }
    fn remove(&mut self, root: &std::path::Path, path: &str) -> Result<(), String> {
        if self.phase == "before-retirement" {
            std::process::exit(74);
        }
        self.inner.remove(root, path)?;
        if self.phase == "after-retirement" {
            std::process::exit(74);
        }
        Ok(())
    }
}

#[test]
fn checkpoint_death_child() {
    let Some(root) = std::env::var_os("FUTO_EDITOR_CHECKPOINT_VAULT") else {
        return;
    };
    let store = LocalNoteStore::new(root.into());
    let defaults = RecoveryOptions::default();
    let mut editor = store
        .open_editor_with_recovery(
            "plain",
            RecoveryOptions {
                clock: defaults.clock,
                storage: Box::new(CrashStorage {
                    inner: defaults.storage,
                    phase: std::env::var("FUTO_EDITOR_CHECKPOINT_PHASE").unwrap(),
                }),
            },
        )
        .unwrap();
    editor.replace(Revision(0), range(5, 5), "!").unwrap();
    if std::env::var("FUTO_EDITOR_CHECKPOINT_CONFLICT").unwrap() == "yes" {
        store.write("plain", "peer", None).unwrap();
    }
    editor.checkpoint().unwrap();
    panic!("checkpoint death was not injected");
}

#[test]
fn power_loss_after_unlink_before_directory_flush_repeats_retirement_without_another_park() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let parked;
    {
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
        store.write("plain", "peer", None).unwrap();
        disk.lock().unwrap().fault = Some(Fault::RetireSync);
        let Err(EditorStoreError::CheckpointCommitted { result, .. }) = editor.checkpoint() else {
            panic!("must report committed save")
        };
        let FlushDisposition::ParkedConflict { parked_id } = result.disposition else {
            panic!("must park")
        };
        parked = parked_id;
    }
    {
        let mut disk = disk.lock().unwrap();
        assert!(disk.accepted.is_empty());
        disk.power_loss();
        assert_eq!(disk.accepted.len(), 1);
        disk.fault = None;
    }
    let mut editor = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    assert_eq!(editor.source_text(), "plain!");
    assert!(editor.recovery_status().paused);
    editor.checkpoint().unwrap();
    assert_eq!(editor.id(), parked);
    assert_eq!(store.read("plain").unwrap(), "peer");
    assert_eq!(store.read(&parked).unwrap(), "plain!");
    assert_eq!(store.snapshot().notes.len(), 2);
    assert!(disk.lock().unwrap().durable.is_empty());
}
