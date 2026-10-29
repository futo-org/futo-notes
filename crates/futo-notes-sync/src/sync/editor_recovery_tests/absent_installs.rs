//! An external writer can appear after the guarded workflow's absence check.
use super::*;
use crate::fault_injection::{Fault, Route, When};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

fn tracked(base_url: String) -> ConnectedState {
    ConnectedState {
        base_url,
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: [5; 32],
        object_map: HashMap::from([(
            "source.md".into(),
            E2eeObjectMapEntry {
                object_id: "peer".into(),
                version: 0,
                blob_key: "old".into(),
                hash: Some(hash_sha256("old base")),
                mtime_ms: None,
                size_bytes: None,
            },
        )]),
        pending_creates: HashMap::new(),
        max_version: 0,
        pull_cursor: 0,
        oversize_skip: HashMap::new(),
    }
}

#[tokio::test]
async fn required_absent_replacement_preserves_late_target_and_falls_back_to_source() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "source", "matching local").unwrap();
    let server = Arc::new(
        FaultServer::new()
            .note(&[5; 32], "peer", 1, "target.md", "matching local")
            .fail(Route::UpdateObject, When::Always, Fault::VersionConflict)
            .start(),
    );
    let state = tracked(server.base_url.clone());
    let planted = Arc::new(AtomicBool::new(false));
    let writer_planted = planted.clone();
    let writer_server = server.clone();
    let writer_root = root.path().to_owned();
    let pre = move |name: &str| {
        if name == "target.md" && !writer_planted.swap(true, Ordering::SeqCst) {
            assert!(
                writer_server.requests(Route::UpdateObject) > 0,
                "push precedes adoption"
            );
            std::fs::write(writer_root.join(name), "independent newcomer").unwrap();
        }
    };
    let (summary, next) = crate::run_sync(&state, root.path(), &|_| {}, &pre)
        .await
        .unwrap();
    assert!(
        planted.load(Ordering::SeqCst),
        "did not reach decision window: {summary:?}"
    );
    assert_eq!(store.read("target").unwrap(), "independent newcomer");
    assert_eq!(store.read("source").unwrap(), "matching local");
    assert!(summary.renamed.is_empty(), "{summary:?}");
    assert!(next.object_map.contains_key("source.md"));
}

#[tokio::test]
async fn required_absent_copy_preserves_late_target_and_both_versions() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "source", "local fork").unwrap();
    let server = Arc::new(
        FaultServer::new()
            .note(&[5; 32], "peer", 1, "source.md", "remote fork")
            .fail(Route::UpdateObject, When::Always, Fault::VersionConflict)
            .start(),
    );
    let state = tracked(server.base_url.clone());
    let target = futo_notes_core::conflict_names::conflict_filename(
        "source.md",
        &futo_notes_core::conflict_names::current_conflict_date(),
        &Default::default(),
    );
    let planted = Arc::new(AtomicBool::new(false));
    let writer_planted = planted.clone();
    let writer_server = server.clone();
    let writer_root = root.path().to_owned();
    let writer_target = target.clone();
    let pre = move |name: &str| {
        if name == writer_target && !writer_planted.swap(true, Ordering::SeqCst) {
            assert!(
                writer_server.requests(Route::UpdateObject) > 0,
                "push precedes conflict copy"
            );
            std::fs::write(writer_root.join(name), "independent newcomer").unwrap();
        }
    };
    let (summary, next) = crate::run_sync(&state, root.path(), &|_| {}, &pre)
        .await
        .unwrap();
    assert!(
        planted.load(Ordering::SeqCst),
        "did not reach decision window: {summary:?}"
    );
    assert_eq!(
        store.read(target.strip_suffix(".md").unwrap()).unwrap(),
        "independent newcomer"
    );
    assert_eq!(store.read("source").unwrap(), "local fork");
    // The remote remains on the server for retry; this failed copy cannot adopt it.
    assert_eq!(server.requests(Route::CreateObject), 0);
    let (retried, settled) = crate::run_sync(&next, root.path(), &|_| {}, &|_| {})
        .await
        .unwrap();
    assert!(retried.failures.is_empty(), "{retried:?}");
    assert_eq!(store.read("source").unwrap(), "remote fork");
    assert_eq!(
        store.read(target.strip_suffix(".md").unwrap()).unwrap(),
        "independent newcomer"
    );
    let versions: Vec<_> = store
        .snapshot()
        .notes
        .iter()
        .map(|note| store.read(&note.id).unwrap())
        .collect();
    assert_eq!(
        versions
            .iter()
            .filter(|body| body.as_str() == "local fork")
            .count(),
        1
    );
    let count = store.snapshot().notes.len();
    crate::run_sync(&settled, root.path(), &|_| {}, &|_| {})
        .await
        .unwrap();
    assert_eq!(store.snapshot().notes.len(), count);
    assert_eq!(store.read("source").unwrap(), "remote fork");
    assert_eq!(
        store.read(target.strip_suffix(".md").unwrap()).unwrap(),
        "independent newcomer"
    );
}

#[tokio::test]
async fn required_absent_delete_conflict_preserves_late_target_and_falls_back_to_source() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    let server = Arc::new(
        FaultServer::new()
            .note(&[5; 32], "peer", 1, "target.md", "remote winner")
            .fail(Route::DeleteObject, When::Always, Fault::VersionConflict)
            .start(),
    );
    let state = tracked(server.base_url.clone());
    let planted = Arc::new(AtomicBool::new(false));
    let writer_planted = planted.clone();
    let writer_server = server.clone();
    let writer_root = root.path().to_owned();
    let pre = move |name: &str| {
        if name == "target.md" && !writer_planted.swap(true, Ordering::SeqCst) {
            assert!(
                writer_server.requests(Route::DeleteObject) > 0,
                "push delete precedes adoption"
            );
            std::fs::write(writer_root.join(name), "independent newcomer").unwrap();
        }
    };
    let (summary, next) = crate::run_sync(&state, root.path(), &|_| {}, &pre)
        .await
        .unwrap();
    assert!(
        planted.load(Ordering::SeqCst),
        "did not reach decision window: {summary:?}"
    );
    assert_eq!(store.read("target").unwrap(), "independent newcomer");
    assert_eq!(store.read("source").unwrap(), "remote winner");
    assert!(next.object_map.contains_key("source.md"));
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn required_absent_install_keeps_source_when_directory_durability_fails() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    store.create("", "source", "matching local").unwrap();
    let server = FaultServer::new()
        .note(&[5; 32], "peer", 1, "target.md", "matching local")
        .fail(Route::UpdateObject, When::Always, Fault::VersionConflict)
        .start();
    let state = tracked(server.base_url.clone());
    let injected = Arc::new(AtomicBool::new(false));
    let writer_injected = injected.clone();
    let pre = move |name: &str| {
        if name == "target.md" && !writer_injected.swap(true, Ordering::SeqCst) {
            futo_notes_core::files::vault_fs::fail_directory_sync_on_call(1);
        }
    };
    let (summary, _) = crate::run_sync(&state, root.path(), &|_| {}, &pre)
        .await
        .unwrap();
    assert!(injected.load(Ordering::SeqCst));
    assert!(
        !summary.failures.is_empty(),
        "directory sync failure must be reported"
    );
    assert_eq!(store.read("source").unwrap(), "matching local");
    assert_eq!(store.read("target").unwrap(), "matching local");
}
