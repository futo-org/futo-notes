//! Which server object each journaled move carries: swaps, folders, deletes
//! and reused names.

use futo_notes_store::LocalNoteStore;

use crate::fault_injection::{Fault, FaultServer, Route, When};
use crate::journal::SyncRunJournal;
use crate::sync::cycle;

use super::*;

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

#[tokio::test]
async fn deleting_the_moved_note_never_hands_its_object_to_a_newcomer_from_its_old_name() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj-a", 1, "a.md", "A")
        .start();
    let state = synced_notes(root.path(), &server.base_url, &[("a.md", "obj-a", "A")]);
    let store = LocalNoteStore::new(root.path().to_owned());
    store.rename("a", "b").unwrap();
    store.write("a", "newcomer", None).unwrap();
    store.rename("a", "c").unwrap();
    store.delete("b").unwrap();

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
        object_at(&after, "c.md").is_some_and(|id| id != "obj-a"),
        "{:?}",
        after.object_map
    );
    assert_eq!(server.requests(Route::DeleteObject), 1, "obj-a is deleted");
    assert_eq!(server.requests(Route::UpdateObject), 0);
    assert!(intents(root.path()).is_empty());
}

#[tokio::test]
async fn a_newcomer_renamed_away_from_a_deleted_bound_destination_gets_its_own_object() {
    let root = TempRoot::new();
    let server = FaultServer::new()
        .note(&KEY, "obj-a", 1, "a.md", "A")
        .fail(Route::UpdateObject, When::Nth(1), Fault::Status(500))
        .start();
    let state = synced_notes(root.path(), &server.base_url, &[("a.md", "obj-a", "A")]);
    let store = LocalNoteStore::new(root.path().to_owned());
    store.rename("a", "b").unwrap();
    let journal = SyncRunJournal::disabled();
    let (_, after_failure) = cycle(&state, root.path(), &no_progress, &no_pre_write, &journal)
        .await
        .unwrap();
    assert_eq!(
        object_at(&after_failure, "b.md"),
        Some("obj-a"),
        "bound and rekeyed"
    );
    store.delete("b").unwrap();
    store.write("b", "unrelated", None).unwrap();
    store.rename("b", "c").unwrap();

    let (summary, after) = cycle(
        &after_failure,
        root.path(),
        &no_progress,
        &no_pre_write,
        &journal,
    )
    .await
    .unwrap();

    assert!(summary.failures.is_empty(), "{summary:?}");
    assert!(
        object_at(&after, "c.md").is_some_and(|id| id != "obj-a"),
        "{:?}",
        after.object_map
    );
    assert_eq!(server.requests(Route::DeleteObject), 1, "obj-a is deleted");
    assert_eq!(
        server.requests(Route::UpdateObject),
        1,
        "only the failed PUT"
    );
    assert!(intents(root.path()).is_empty());
}
