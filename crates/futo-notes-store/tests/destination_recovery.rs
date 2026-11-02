use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};
use futo_notes_store::{FlushDisposition, LocalNoteStore};
fn pending(store: &LocalNoteStore, root: &std::path::Path, id: &str) {
    let (folder, title) = id.rsplit_once('/').unwrap_or(("", id));
    store.create(folder, title, "local edit").unwrap();
    let mut e = store.open_editor(id).unwrap();
    e.replace(
        Revision(0),
        DisplayRange {
            start: DisplayOffset(10),
            end: DisplayOffset(10),
        },
        " older draft",
    )
    .unwrap();
    drop(e);
    std::fs::remove_file(root.join(format!("{id}.md"))).unwrap();
}
fn preserved(store: &LocalNoteStore, id: &str) {
    assert_eq!(store.read(id).unwrap(), "local edit");
    let mut e = store.open_editor(id).unwrap();
    assert_eq!(e.source_text(), "local edit older draft");
    let saved = e.checkpoint().unwrap();
    assert_eq!(
        store.read(id).unwrap(),
        "local edit",
        "installed destination overwritten"
    );
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("must park")
    };
    let mutation = saved.mutation.unwrap();
    assert_eq!(mutation.final_id.as_deref(), Some(parked_id.as_str()));
    assert_eq!(mutation.upserted.len(), 1);
    assert_eq!(mutation.upserted[0].note.id, parked_id);
    assert_eq!(
        store.snapshot().notes[mutation.upserted[0].position as usize].id,
        parked_id
    );
    assert!(mutation.removed.is_empty());
    assert!(mutation.renamed.is_empty());
    assert!(mutation.relinked.is_empty());
    assert_eq!(mutation.folders, store.snapshot().folders);
    assert!(mutation.warnings.is_empty());
    assert_eq!(mutation.final_folder, None);
    assert_eq!(store.read(&parked_id).unwrap(), "local edit older draft");
    let notes = store.snapshot().notes.len();
    assert_eq!(
        e.checkpoint().unwrap().disposition,
        FlushDisposition::Converged
    );
    drop(e);
    for _ in 0..2 {
        store.open_editor(id).unwrap().checkpoint().unwrap();
        store.open_editor(&parked_id).unwrap().checkpoint().unwrap();
        assert_eq!(store.snapshot().notes.len(), notes);
        assert_eq!(store.read(id).unwrap(), "local edit");
        assert_eq!(store.read(&parked_id).unwrap(), "local edit older draft");
    }
}
#[test]
fn control_public_write_protects() {
    let r = tempfile::tempdir().unwrap();
    let s = LocalNoteStore::new(r.path().to_owned());
    pending(&s, r.path(), "target");
    s.write("target", "local edit", None).unwrap();
    preserved(&s, "target");
}
#[test]
fn bootstrap_txt_migration() {
    let r = tempfile::tempdir().unwrap();
    let s = LocalNoteStore::new(r.path().to_owned());
    pending(&s, r.path(), "target");
    std::fs::write(r.path().join("target.txt"), "local edit").unwrap();
    s.bootstrap().unwrap();
    preserved(&s, "target");
}
#[test]
fn bootstrap_canonical_backup_restore() {
    let r = tempfile::tempdir().unwrap();
    let s = LocalNoteStore::new(r.path().to_owned());
    pending(&s, r.path(), "target");
    std::fs::write(r.path().join(".sf-bak-probe"), "local edit").unwrap();
    std::fs::write(r.path().join(".sf-bak-probe.path"), "target.md").unwrap();
    s.bootstrap().unwrap();
    preserved(&s, "target");
}
#[test]
fn bootstrap_divergent_backup_park() {
    let r = tempfile::tempdir().unwrap();
    let s = LocalNoteStore::new(r.path().to_owned());
    pending(&s, r.path(), "target (recovered)");
    s.create("", "target", "independent").unwrap();
    std::fs::write(r.path().join(".sf-bak-probe"), "local edit").unwrap();
    std::fs::write(r.path().join(".sf-bak-probe.path"), "target.md").unwrap();
    s.bootstrap().unwrap();
    preserved(&s, "target (recovered)");
}
#[test]
fn folder_rename() {
    let r = tempfile::tempdir().unwrap();
    let s = LocalNoteStore::new(r.path().to_owned());
    s.create_folder("to").unwrap();
    pending(&s, r.path(), "to/target");
    std::fs::remove_dir(r.path().join("to")).unwrap();
    s.create_folder("from").unwrap();
    s.create("from", "target", "local edit").unwrap();
    s.rename_folder("from", "to").unwrap();
    preserved(&s, "to/target");
}

#[test]
fn folder_late_external_source_descendant() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    struct Hook {
        root: std::path::PathBuf,
        armed: AtomicBool,
    }
    impl futo_notes_store::BeforeWrite for Hook {
        fn before_write(&self, _: &[futo_notes_store::FileChange]) {
            if self.armed.swap(false, Ordering::SeqCst) {
                std::fs::write(self.root.join("from/late.md"), "local edit").unwrap();
            }
        }
    }
    let r = tempfile::tempdir().unwrap();
    let hook = Arc::new(Hook {
        root: r.path().to_owned(),
        armed: AtomicBool::new(false),
    });
    let s = LocalNoteStore::with_before_write(r.path().to_owned(), hook.clone());
    s.create_folder("to").unwrap();
    pending(&s, r.path(), "to/late");
    std::fs::remove_dir(r.path().join("to")).unwrap();
    s.create_folder("from").unwrap();
    hook.armed.store(true, Ordering::SeqCst);
    s.rename_folder("from", "to").unwrap();
    preserved(&s, "to/late");
}
#[test]
fn public_rename_preserves_absent_destinations_pending_recovery() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    pending(&store, root.path(), "target");
    store.create("", "source", "local edit").unwrap();
    let moved = store.rename("source", "target").unwrap();
    assert_eq!(moved.final_id.as_deref(), Some("target"));
    assert_eq!(moved.removed, ["source"]);
    assert_eq!(moved.renamed.len(), 1);
    preserved(&store, "target");
}

#[path = "destination_recovery/destination_failures.rs"]
mod destination_failures;

#[path = "destination_recovery/destination_identity.rs"]
mod destination_identity;

#[path = "destination_recovery/scoped_pause.rs"]
mod scoped_pause;
