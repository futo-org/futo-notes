//! Journaled local renames (#214) at the failure boundaries a real server
//! cannot be made to produce: a failed rename PUT, a checkpoint that does not
//! save after it, and a rename landing between the scan and the pull's write.
//! The stub server is stateless, so each test asserts only what its single
//! object and the local journal must show; whole flows run against the real
//! server in `tests/server_integration/round_trip.rs`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futo_notes_core::hash::hash_sha256;
use futo_notes_store::rename_journal::{set_rename_scope, with_rename_journal};
use futo_notes_store::LocalNoteStore;

use crate::checkpoint::{self, ConnectedState, ObjectState};
use crate::fault_injection::{restart_from_checkpoint, Fault, FaultServer, Route, When};
use crate::journal::SyncRunJournal;

use super::{cycle, cycle_with_checkpoint};

struct TempRoot(std::path::PathBuf);

impl TempRoot {
    fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-sync-local-rename-test-{}-{}-{n}",
            std::process::id(),
            futo_notes_core::files::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn no_progress(_: super::SyncProgress) {}

fn no_pre_write(_: &str) {}

const KEY: [u8; 32] = [5; 32];

/// A vault whose `old.md` is synced as object `obj` (v1), with its checkpoint
/// saved and the rename journal scoped to the collection.
fn synced(root: &Path, base_url: &str) -> ConnectedState {
    std::fs::write(root.join("old.md"), "body").unwrap();
    let state = ConnectedState {
        base_url: base_url.to_owned(),
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: KEY,
        object_map: HashMap::from([(
            "old.md".to_owned(),
            ObjectState {
                object_id: "obj".into(),
                version: 1,
                blob_key: "obj-blob".into(),
                hash: Some(hash_sha256("body")),
                mtime_ms: None,
                size_bytes: Some(4),
            },
        )]),
        pending_creates: HashMap::new(),
        max_version: 1,
        pull_cursor: 1,
        oversize_skip: HashMap::new(),
    };
    checkpoint::save(root, &state).unwrap();
    set_rename_scope(root, Some("collection")).unwrap();
    state
}

fn intents(root: &Path) -> Vec<(String, String, Option<String>)> {
    with_rename_journal(root, |journal| {
        journal
            .intents()
            .into_iter()
            .map(|intent| (intent.from, intent.to, intent.object_id))
            .collect()
    })
    .unwrap()
}

fn carried(state: &ConnectedState) -> bool {
    !state.object_map.contains_key("old.md")
        && state
            .object_map
            .get("new.md")
            .is_some_and(|entry| entry.object_id == "obj")
}

#[tokio::test]
async fn a_failed_rename_put_keeps_the_intent_and_the_retry_carries_the_same_object() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj", 1, "old.md", "body")
        .fail(Route::UpdateObject, When::Nth(1), Fault::Status(500))
        .start();
    let state = synced(root.path(), &server.base_url);
    LocalNoteStore::new(root.path().to_owned())
        .rename("old", "new")
        .unwrap();
    let journal = SyncRunJournal::disabled();

    let (failed, after_failure) = cycle(&state, root.path(), &no_progress, &no_pre_write, &journal)
        .await
        .unwrap();

    assert!(!failed.failures.is_empty(), "the rename PUT failed");
    assert!(!root.path().join("old.md").exists(), "no resurrection");
    assert_eq!(
        intents(root.path()),
        vec![("old.md".into(), "new.md".into(), Some("obj".into()))]
    );

    let (retried, after_retry) = cycle(
        &after_failure,
        root.path(),
        &no_progress,
        &no_pre_write,
        &journal,
    )
    .await
    .unwrap();

    assert!(retried.failures.is_empty(), "{retried:?}");
    assert!(carried(&after_retry), "{:?}", after_retry.object_map);
    assert_eq!(server.requests(Route::UpdateObject), 2);
    assert_eq!(server.requests(Route::CreateObject), 0);
    assert_eq!(server.requests(Route::DeleteObject), 0);
    assert!(intents(root.path()).is_empty());
}

#[tokio::test]
async fn an_unsaved_checkpoint_after_the_rename_put_replays_against_the_same_object() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj", 1, "old.md", "body")
        .start();
    let state = synced(root.path(), &server.base_url);
    LocalNoteStore::new(root.path().to_owned())
        .rename("old", "new")
        .unwrap();
    let journal = SyncRunJournal::disabled();
    let unsaved = |_: &Path, _: &ConnectedState| Err("disk full".to_owned());

    let _ = cycle_with_checkpoint(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &unsaved,
        &journal,
    )
    .await;

    assert_eq!(server.requests(Route::UpdateObject), 1, "the PUT landed");
    assert_eq!(
        intents(root.path()).len(),
        1,
        "not acknowledged without a durable checkpoint"
    );
    // A restart reads the checkpoint from before the rename.
    let restarted = restart_from_checkpoint(root.path(), &state);
    assert!(restarted.object_map.contains_key("old.md"));

    let (replayed, after_replay) = cycle(
        &restarted,
        root.path(),
        &no_progress,
        &no_pre_write,
        &journal,
    )
    .await
    .unwrap();

    assert!(replayed.failures.is_empty(), "{replayed:?}");
    assert!(carried(&after_replay), "{:?}", after_replay.object_map);
    assert_eq!(server.requests(Route::UpdateObject), 2);
    assert_eq!(server.requests(Route::CreateObject), 0);
    assert_eq!(server.requests(Route::DeleteObject), 0);
    assert!(intents(root.path()).is_empty());
}

#[tokio::test]
async fn a_rename_landing_before_the_pull_writes_its_source_is_not_undone() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj", 2, "old.md", "peer body")
        .start();
    let mut state = synced(root.path(), &server.base_url);
    // The peer's newer revision: same object, another blob.
    state.object_map.get_mut("old.md").unwrap().blob_key = "obj-older-blob".into();
    checkpoint::save(root.path(), &state).unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    let renamed = Arc::new(Mutex::new(false));
    let flag = renamed.clone();
    // The pull announces each write before taking the vault guard; the user's
    // rename lands in exactly that gap, after this cycle's scan.
    let rename_in_gap = move |name: &str| {
        let mut renamed = flag.lock().unwrap();
        if name == "old.md" && !*renamed {
            store.rename("old", "new").unwrap();
            *renamed = true;
        }
    };

    let (_, after) = cycle(
        &state,
        root.path(),
        &no_progress,
        &rename_in_gap,
        &SyncRunJournal::disabled(),
    )
    .await
    .unwrap();

    assert!(*renamed.lock().unwrap(), "the race was exercised");
    assert!(!root.path().join("old.md").exists(), "no resurrection");
    assert_eq!(
        std::fs::read_to_string(root.path().join("new.md")).unwrap(),
        "body"
    );
    assert_eq!(server.requests(Route::CreateObject), 0);
    assert_eq!(server.requests(Route::DeleteObject), 0);
    assert_eq!(
        intents(root.path()),
        vec![("old.md".into(), "new.md".into(), None)],
        "left for the next cycle to claim"
    );
    assert!(after.object_map.contains_key("old.md"));
}

/// Notes synced as `(name, object id, body)`, journal scoped.
fn synced_notes(root: &Path, base_url: &str, notes: &[(&str, &str, &str)]) -> ConnectedState {
    let mut state = synced(root, base_url);
    std::fs::remove_file(root.join("old.md")).unwrap();
    state.object_map.clear();
    for (name, object_id, body) in notes {
        std::fs::write(root.join(name), body).unwrap();
        state.object_map.insert(
            (*name).to_owned(),
            ObjectState {
                object_id: (*object_id).to_owned(),
                version: 1,
                blob_key: format!("{object_id}-blob"),
                hash: Some(hash_sha256(body)),
                mtime_ms: None,
                size_bytes: Some(body.len() as u64),
            },
        );
    }
    checkpoint::save(root, &state).unwrap();
    state
}

fn object_at<'a>(state: &'a ConnectedState, name: &str) -> Option<&'a str> {
    state
        .object_map
        .get(name)
        .map(|entry| entry.object_id.as_str())
}

#[tokio::test]
async fn swapping_two_names_carries_both_objects() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj-a", 1, "a.md", "A")
        .note(&KEY, "obj-b", 1, "b.md", "B")
        .start();
    let state = synced_notes(
        root.path(),
        &server.base_url,
        &[("a.md", "obj-a", "A"), ("b.md", "obj-b", "B")],
    );
    let store = LocalNoteStore::new(root.path().to_owned());
    store.rename("a", "swap").unwrap();
    store.rename("b", "a").unwrap();
    store.rename("swap", "b").unwrap();

    let (summary, after) = cycle(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &SyncRunJournal::disabled(),
    )
    .await
    .unwrap();

    assert!(summary.failures.is_empty(), "{summary:?}");
    assert_eq!(object_at(&after, "a.md"), Some("obj-b"));
    assert_eq!(object_at(&after, "b.md"), Some("obj-a"));
    assert_eq!(server.requests(Route::UpdateObject), 2);
    assert_eq!(server.requests(Route::CreateObject), 0);
    assert_eq!(server.requests(Route::DeleteObject), 0);
    assert!(intents(root.path()).is_empty());
}

#[tokio::test]
async fn a_renamed_note_deleted_before_its_name_is_reused_is_not_claimed_by_the_newcomer() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj-a", 1, "a.md", "A")
        .note(&KEY, "obj-b", 1, "b.md", "B")
        .start();
    let state = synced_notes(
        root.path(),
        &server.base_url,
        &[("a.md", "obj-a", "A"), ("b.md", "obj-b", "B")],
    );
    let store = LocalNoteStore::new(root.path().to_owned());
    store.rename("a", "x").unwrap();
    store.delete("x").unwrap();
    store.rename("b", "x").unwrap();

    let (summary, after) = cycle(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &SyncRunJournal::disabled(),
    )
    .await
    .unwrap();

    assert!(summary.failures.is_empty(), "{summary:?}");
    assert_eq!(object_at(&after, "x.md"), Some("obj-b"));
    assert!(!after.object_map.contains_key("a.md") && !after.object_map.contains_key("b.md"));
    assert_eq!(server.requests(Route::DeleteObject), 1, "obj-a is deleted");
    assert_eq!(server.requests(Route::CreateObject), 0);
    assert!(intents(root.path()).is_empty());
}

fn write_note(root: &Path, name: &str, body: &str) {
    let path = root.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

#[tokio::test]
async fn a_folder_move_with_one_failed_put_retries_that_note() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj-a", 1, "Proj/a.md", "A")
        .note(&KEY, "obj-b", 1, "Proj/b.md", "B")
        .fail(Route::UpdateObject, When::Nth(1), Fault::Status(500))
        .start();
    write_note(root.path(), "Proj/a.md", "A");
    write_note(root.path(), "Proj/b.md", "B");
    let state = synced_notes(
        root.path(),
        &server.base_url,
        &[("Proj/a.md", "obj-a", "A"), ("Proj/b.md", "obj-b", "B")],
    );
    LocalNoteStore::new(root.path().to_owned())
        .rename_folder("Proj", "Work")
        .unwrap();
    let journal = SyncRunJournal::disabled();

    let (failed, after_failure) = cycle(&state, root.path(), &no_progress, &no_pre_write, &journal)
        .await
        .unwrap();
    assert!(!failed.failures.is_empty(), "one rename PUT failed");
    let (retried, after_retry) = cycle(
        &after_failure,
        root.path(),
        &no_progress,
        &no_pre_write,
        &journal,
    )
    .await
    .unwrap();

    assert!(retried.failures.is_empty(), "{retried:?}");
    assert_eq!(object_at(&after_retry, "Work/a.md"), Some("obj-a"));
    assert_eq!(object_at(&after_retry, "Work/b.md"), Some("obj-b"));
    assert_eq!(
        server.requests(Route::UpdateObject),
        3,
        "the failed PUT is retried"
    );
    assert!(intents(root.path()).is_empty());
}

#[tokio::test]
async fn a_folder_move_holding_a_never_synced_note_still_retries_a_failed_put() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj-a", 1, "Proj/a.md", "A")
        .fail(Route::UpdateObject, When::Nth(1), Fault::Status(500))
        .start();
    write_note(root.path(), "Proj/a.md", "A");
    let state = synced_notes(
        root.path(),
        &server.base_url,
        &[("Proj/a.md", "obj-a", "A")],
    );
    write_note(root.path(), "Proj/new.md", "never synced");
    LocalNoteStore::new(root.path().to_owned())
        .rename_folder("Proj", "Work")
        .unwrap();
    let journal = SyncRunJournal::disabled();

    let (_, after_failure) = cycle(&state, root.path(), &no_progress, &no_pre_write, &journal)
        .await
        .unwrap();
    let (retried, after_retry) = cycle(
        &after_failure,
        root.path(),
        &no_progress,
        &no_pre_write,
        &journal,
    )
    .await
    .unwrap();

    assert!(retried.failures.is_empty(), "{retried:?}");
    assert_eq!(object_at(&after_retry, "Work/a.md"), Some("obj-a"));
    assert_eq!(
        server.requests(Route::UpdateObject),
        2,
        "the failed PUT is retried"
    );
    assert!(intents(root.path()).is_empty());
}

#[tokio::test]
async fn a_new_note_reusing_a_renamed_source_name_gets_its_own_object() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj-a", 1, "a.md", "A")
        .start();
    let state = synced_notes(root.path(), &server.base_url, &[("a.md", "obj-a", "A")]);
    let store = LocalNoteStore::new(root.path().to_owned());
    store.rename("a", "b").unwrap();
    store.write("a", "newcomer", None).unwrap();
    store.rename("a", "c").unwrap();

    let (summary, after) = cycle(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &SyncRunJournal::disabled(),
    )
    .await
    .unwrap();

    assert!(summary.failures.is_empty(), "{summary:?}");
    assert_eq!(object_at(&after, "b.md"), Some("obj-a"));
    assert!(
        object_at(&after, "c.md").is_some_and(|id| id != "obj-a"),
        "{:?}",
        after.object_map
    );
    assert_eq!(server.requests(Route::UpdateObject), 1);
    assert_eq!(server.requests(Route::CreateObject), 1);
    assert!(intents(root.path()).is_empty());
}

#[tokio::test]
async fn a_deleted_rename_destination_reused_by_a_new_note_is_not_the_moved_note() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj-a", 1, "a.md", "A")
        .start();
    let state = synced_notes(root.path(), &server.base_url, &[("a.md", "obj-a", "A")]);
    let store = LocalNoteStore::new(root.path().to_owned());
    store.rename("a", "b").unwrap();
    store.delete("b").unwrap();
    store.write("b", "unrelated", None).unwrap();

    let (summary, after) = cycle(
        &state,
        root.path(),
        &no_progress,
        &no_pre_write,
        &SyncRunJournal::disabled(),
    )
    .await
    .unwrap();

    assert!(summary.failures.is_empty(), "{summary:?}");
    assert!(
        object_at(&after, "b.md").is_some_and(|id| id != "obj-a"),
        "{:?}",
        after.object_map
    );
    assert_eq!(server.requests(Route::DeleteObject), 1, "obj-a is deleted");
    assert_eq!(server.requests(Route::UpdateObject), 0);
    assert!(intents(root.path()).is_empty());
}
