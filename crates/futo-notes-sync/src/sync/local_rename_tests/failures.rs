//! Journaled renames across failed PUTs, unsaved checkpoints and races with
//! the pull's writes and the push's scan.

use std::path::Path;
use std::sync::{Arc, Mutex};

use futo_notes_store::LocalNoteStore;

use crate::checkpoint::{self, ConnectedState};
use crate::fault_injection::{restart_from_checkpoint, Fault, FaultServer, Route, When};
use crate::journal::SyncRunJournal;
use crate::sync::{cycle, cycle_with_checkpoint};

use super::*;

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

#[tokio::test]
async fn a_scan_landing_mid_rename_never_tombstones_the_moved_note() {
    use std::sync::mpsc;

    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj", 1, "old.md", "body")
        .start();
    let state = synced(root.path(), &server.base_url);
    let journal = SyncRunJournal::disabled();
    let vault = root.path().to_owned();
    let (staged_tx, staged_rx) = mpsc::channel::<()>();
    let (resume_tx, resume_rx) = mpsc::channel::<()>();
    let resume_rx = Arc::new(Mutex::new(resume_rx));
    let renamer = Arc::new(Mutex::new(None));
    let slot = renamer.clone();
    let mut resume = Some(resume_tx);
    let mut staged_tx = Some(staged_tx);
    // Before the scan: a rename starts and parks the note in its staging,
    // where it is at neither name. After the scan: the rename finishes, and
    // this cycle's claim waits on the vault guard until it has committed.
    crate::sync::push::scan_hook::on_scan(move |point| match point {
        "before" => {
            let (staged, resume_rx, vault) =
                (staged_tx.take().unwrap(), resume_rx.clone(), vault.clone());
            *slot.lock().unwrap() = Some(std::thread::spawn(move || {
                futo_notes_store::rename_journal::tests_support::on_step(move |step| {
                    if step == "stage" {
                        staged.send(()).unwrap();
                        resume_rx.lock().unwrap().recv().unwrap();
                    }
                    Ok(())
                });
                LocalNoteStore::new(vault).rename("old", "new").unwrap();
            }));
            staged_rx.recv().unwrap();
        }
        _ => {
            if let Some(resume) = resume.take() {
                resume.send(()).unwrap();
            }
        }
    });

    let raced = cycle(&state, root.path(), &no_progress, &no_pre_write, &journal).await;
    crate::sync::push::scan_hook::clear();
    renamer.lock().unwrap().take().unwrap().join().unwrap();
    let (_, raced) = raced.unwrap();

    assert_eq!(
        server.requests(Route::DeleteObject),
        0,
        "no false tombstone"
    );
    assert_eq!(server.requests(Route::CreateObject), 0);

    let (_, after) = cycle(&raced, root.path(), &no_progress, &no_pre_write, &journal)
        .await
        .unwrap();
    assert!(carried(&after), "{:?}", after.object_map);
    assert_eq!(server.requests(Route::DeleteObject), 0);
    assert_eq!(server.requests(Route::CreateObject), 0);
    assert!(intents(root.path()).is_empty());
}
