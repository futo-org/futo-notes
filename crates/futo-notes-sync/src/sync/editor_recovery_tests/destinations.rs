//! Public sync/store workflows with genuine source edits and scripted network input.
use crate::fault_injection::FaultServer;
use crate::{ConnectedState, E2eeObjectMapEntry};
use futo_notes_core::hash::hash_sha256;
use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};
use futo_notes_store::{FlushDisposition, LocalNoteStore};
use std::collections::HashMap;

#[tokio::test]
async fn tombstone_park_preserves_absent_destinations_pending_recovery() {
    use futo_notes_core::conflict_names::collision_conflict_filename;
    use std::sync::atomic::{AtomicBool, Ordering};
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    let target_file = collision_conflict_filename("plain.md", "peer");
    let target = target_file.strip_suffix(".md").unwrap();
    store.create("", target, "local edit").unwrap();
    {
        let mut editor = store.open_editor(target).unwrap();
        editor
            .replace(
                Revision(0),
                DisplayRange {
                    start: DisplayOffset(10),
                    end: DisplayOffset(10),
                },
                " older draft",
            )
            .unwrap();
    }
    std::fs::remove_file(root.path().join(&target_file)).unwrap();
    store.create("", "plain", "old base").unwrap();
    let server = FaultServer::new().tombstone("peer", 1).start();
    let state = ConnectedState {
        base_url: server.base_url.clone(),
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: [5; 32],
        object_map: HashMap::from([(
            "plain.md".into(),
            E2eeObjectMapEntry {
                object_id: "peer".into(),
                version: 0,
                blob_key: "older-blob".into(),
                hash: Some(hash_sha256("old base")),
                mtime_ms: None,
                size_bytes: None,
            },
        )]),
        pending_creates: HashMap::new(),
        max_version: 0,
        pull_cursor: 0,
        oversize_skip: HashMap::new(),
    };
    let edited = AtomicBool::new(false);
    let note_path = root.path().join("plain.md");
    let pre_write = move |name: &str| {
        if name == "plain.md" && !edited.swap(true, Ordering::SeqCst) {
            // A deterministic external edit after push and before the tombstone claim.
            std::fs::write(&note_path, "local edit").unwrap();
        }
    };
    let (summary, _) = crate::run_sync(&state, root.path(), &|_| {}, &pre_write)
        .await
        .unwrap();
    assert!(summary.failures.is_empty(), "{summary:?}");
    assert_eq!(store.read(target).unwrap(), "local edit");
    let mut editor = store.open_editor(target).unwrap();
    assert_eq!(editor.source_text(), "local edit older draft");
    let saved = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("destination recovery must preserve the parked sync content");
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
    assert!(mutation.folders.is_empty());
    assert!(mutation.warnings.is_empty());
    assert_eq!(mutation.final_folder, None);
    assert_eq!(store.read(&parked_id).unwrap(), "local edit older draft");
    drop(editor);
    store.open_editor(target).unwrap().checkpoint().unwrap();
    store.open_editor(&parked_id).unwrap().checkpoint().unwrap();
    assert_eq!(store.snapshot().notes.len(), 2);
    assert_eq!(
        store.read(target).unwrap(),
        "local edit",
        "tombstone park must survive foreign recovery"
    );
}

#[tokio::test]
async fn collision_rename_preserves_absent_destinations_pending_recovery() {
    use futo_notes_core::conflict_names::collision_conflict_filename;
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    let target_file = collision_conflict_filename("plain.md", "peer-z");
    let target = target_file.strip_suffix(".md").unwrap();
    store.create("", target, "local edit").unwrap();
    {
        let mut editor = store.open_editor(target).unwrap();
        editor
            .replace(
                Revision(0),
                DisplayRange {
                    start: DisplayOffset(10),
                    end: DisplayOffset(10),
                },
                " older draft",
            )
            .unwrap();
    }
    std::fs::remove_file(root.path().join(&target_file)).unwrap();
    store.create("", "plain", "local edit").unwrap();
    let server = FaultServer::new()
        .note(&[5; 32], "peer-a", 1, "plain.md", "remote")
        .start();
    let state = ConnectedState {
        base_url: server.base_url.clone(),
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: [5; 32],
        object_map: HashMap::from([(
            "plain.md".into(),
            E2eeObjectMapEntry {
                object_id: "peer-z".into(),
                version: 0,
                blob_key: "older-blob".into(),
                hash: Some(hash_sha256("local edit")),
                mtime_ms: None,
                size_bytes: None,
            },
        )]),
        pending_creates: HashMap::new(),
        max_version: 0,
        pull_cursor: 0,
        oversize_skip: HashMap::new(),
    };
    let (summary, _) = crate::run_sync(&state, root.path(), &|_| {}, &|_| {})
        .await
        .unwrap();
    assert!(summary.failures.is_empty(), "{summary:?}");
    assert_eq!(summary.renamed.len(), 1);
    assert_eq!(summary.renamed[0].from_id, "plain");
    assert_eq!(summary.renamed[0].to_id, target);
    assert_eq!(store.read("plain").unwrap(), "remote");
    assert_eq!(store.read(target).unwrap(), "local edit");
    let mut editor = store.open_editor(target).unwrap();
    assert_eq!(editor.source_text(), "local edit older draft");
    let saved = editor.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
        panic!("recovery must preserve the installed content separately");
    };
    assert_eq!(store.read(&parked_id).unwrap(), "local edit older draft");
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
    assert!(mutation.folders.is_empty());
    assert!(mutation.warnings.is_empty());
    assert_eq!(mutation.final_folder, None);
    drop(editor);
    let count = store.snapshot().notes.len();
    store.open_editor(&parked_id).unwrap().checkpoint().unwrap();
    store.open_editor(target).unwrap().checkpoint().unwrap();
    assert_eq!(store.snapshot().notes.len(), count);
    assert_eq!(store.read(target).unwrap(), "local edit");
}
