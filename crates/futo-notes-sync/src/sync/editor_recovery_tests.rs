//! Public sync/store workflows with genuine source edits and scripted network input.
use crate::fault_injection::{FaultServer, Route};
use crate::{ConnectedState, E2eeObjectMapEntry};
use futo_notes_core::hash::hash_sha256;
use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};
use futo_notes_store::{FlushDisposition, LocalNoteStore};
use std::collections::HashMap;

mod absent_installs;
mod destinations;

#[tokio::test]
async fn crash_then_sync_preserves_restored_checkpoint_and_pending_draft() {
    for outside in ["plain", "outside\r\nbytes  "] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalNoteStore::new(root.path().to_owned());
        store.create("", "plain", "plain").unwrap();
        {
            let mut editor = store.open_editor("plain").unwrap();
            editor
                .replace(
                    Revision(0),
                    DisplayRange {
                        start: DisplayOffset(5),
                        end: DisplayOffset(5),
                    },
                    "!",
                )
                .unwrap();
            assert_eq!(editor.source_text(), "plain!");
        }
        store.create("", "dirty", "push first").unwrap();
        let key = [5; 32];
        let server = std::sync::Arc::new(
            FaultServer::new()
                .note(&key, "peer", 1, "plain.md", outside)
                .start(),
        );
        let state = ConnectedState {
            base_url: server.base_url.clone(),
            token: "token".into(),
            user_id: "user".into(),
            collection_id: "collection".into(),
            vault_key: key,
            object_map: HashMap::from([(
                "plain.md".into(),
                E2eeObjectMapEntry {
                    object_id: "peer".into(),
                    version: 0,
                    blob_key: "older-blob".into(),
                    hash: Some(hash_sha256("plain")),
                    mtime_ms: None,
                    size_bytes: None,
                },
            )]),
            pending_creates: HashMap::new(),
            max_version: 0,
            pull_cursor: 0,
            oversize_skip: HashMap::new(),
        };
        let writer_server = server.clone();
        let pre_write = move |name: &str| {
            if name == "plain.md" {
                assert!(
                    writer_server.requests(Route::CreateObject) > 0,
                    "push must precede pull"
                );
            }
        };
        let (summary, next) = crate::run_sync(&state, root.path(), &|_| {}, &pre_write)
            .await
            .unwrap();
        assert!(summary.failures.is_empty(), "{summary:?}");
        assert!(summary.updated_ids.iter().any(|id| id == "plain"));
        assert!(summary.deleted_ids.is_empty());
        assert!(summary.renamed.is_empty());
        let adopted = store
            .refresh_external_changes(&summary.updated_ids, &summary.deleted_ids, &[])
            .unwrap();
        assert_eq!(adopted.upserted.len(), 1);
        assert_eq!(adopted.upserted[0].note.id, "plain");
        assert_eq!(
            store.snapshot().notes[adopted.upserted[0].position as usize].id,
            "plain"
        );
        assert!(adopted.removed.is_empty());
        assert!(adopted.renamed.is_empty());
        assert!(adopted.relinked.is_empty());
        assert!(adopted.folders.is_empty());
        assert!(adopted.warnings.is_empty());
        assert_eq!(adopted.final_id, None);
        assert_eq!(adopted.final_folder, None);
        assert_eq!(store.read("plain").unwrap(), outside);
        let mut editor = store.open_editor("plain").unwrap();
        assert_eq!(editor.source_text(), "plain!");
        let saved = editor.checkpoint().unwrap();
        let FlushDisposition::ParkedConflict { parked_id } = saved.disposition else {
            panic!("sync adoption must preserve the pending draft separately");
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
        assert_eq!(store.read("plain").unwrap(), outside);
        assert_eq!(store.read(&parked_id).unwrap(), "plain!");
        assert_eq!(store.read("dirty").unwrap(), "push first");
        assert_eq!(store.snapshot().notes.len(), 3);
        drop(editor);
        let (retry, _) = crate::run_sync(&next, root.path(), &|_| {}, &|_| {})
            .await
            .unwrap();
        assert!(retry.failures.is_empty(), "{retry:?}");
        store.open_editor("plain").unwrap().checkpoint().unwrap();
        assert_eq!(store.snapshot().notes.len(), 3);
    }
}
