//! The boundary cases from the `docs/learnings/sync-rewrite.md` follow-up
//! queue: failures that only exist behind a particular server response or a
//! particular process interruption. Each is driven through the real push/pull/
//! cycle entry points against `crate::fault_injection`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use futo_notes_core::hash::hash_sha256;

use crate::checkpoint::{Ancestry, ConnectedState};
use crate::fault_injection::{restart_from_checkpoint, Fault, FaultServer, Route, When};

use super::{cycle, pull, push, FailureKind, SyncSummary};

struct TempRoot(std::path::PathBuf);

impl TempRoot {
    fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-sync-failure-boundary-test-{}-{}-{n}",
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

fn connected(base_url: &str) -> ConnectedState {
    ConnectedState {
        base_url: base_url.to_owned(),
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: [5; 32],
        object_map: HashMap::new(),
        max_version: 0,
        pull_cursor: 0,
        oversize_skip: HashMap::new(),
    }
}

fn download_failures(summary: &SyncSummary) -> usize {
    summary
        .failures
        .iter()
        .filter(|failure| failure.kind == FailureKind::Download)
        .count()
}

fn write_ancestry(root: &Path, name: &str, object_id: &str, hash: &str) {
    let ancestry = HashMap::from([(
        name.to_owned(),
        Ancestry {
            object_id: object_id.to_owned(),
            hash: hash.to_owned(),
        },
    )]);
    std::fs::write(
        root.join(".e2ee-ancestry.json"),
        serde_json::json!({ "version": 1, "files": ancestry }).to_string(),
    )
    .unwrap();
}

// Follow-up case 1.
#[tokio::test]
async fn failed_blob_download_caps_the_cursor_and_retries_on_the_next_pull() {
    let root = TempRoot::new();
    let state = connected("");
    let server = FaultServer::new()
        .note(&state.vault_key, "peer", 5, "peer.md", "peer body")
        .fail_blob_of("peer", When::Nth(1), Fault::Status(500))
        .start();
    let state = ConnectedState {
        base_url: server.base_url.clone(),
        ..state
    };

    let (first, after_first) = pull(&state, root.path(), 1, &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(download_failures(&first), 1);
    assert!(!root.path().join("peer.md").exists());
    assert_eq!(
        after_first.pull_cursor, 4,
        "the cursor must stay below the failed change"
    );

    let (second, after_second) = pull(
        &after_first,
        root.path(),
        after_first.pull_cursor,
        &no_progress,
        &no_pre_write,
    )
    .await
    .unwrap();

    assert!(second.failures.is_empty());
    assert_eq!(second.downloaded, 1);
    assert_eq!(
        std::fs::read_to_string(root.path().join("peer.md")).unwrap(),
        "peer body"
    );
    assert_eq!(after_second.pull_cursor, 5);
}

// Follow-up case 2.
#[tokio::test]
async fn empty_map_reconciliation_caps_the_cursor_below_its_failed_download() {
    let root = TempRoot::new();
    let state = connected("");
    let server = FaultServer::new()
        .note(&state.vault_key, "early", 3, "early.md", "early body")
        .note(&state.vault_key, "late", 7, "late.md", "late body")
        .fail_blob_of("early", When::Always, Fault::TruncatedBody)
        .start();
    let state = ConnectedState {
        base_url: server.base_url.clone(),
        ..state
    };

    let (summary, next) = pull(&state, root.path(), 0, &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(download_failures(&summary), 1);
    assert!(!root.path().join("early.md").exists());
    assert_eq!(
        std::fs::read_to_string(root.path().join("late.md")).unwrap(),
        "late body",
        "a later change still applies within the same reconciliation"
    );
    assert_eq!(
        next.pull_cursor, 2,
        "reconciliation must not advance past the earliest failed change"
    );
}

// Follow-up case 3.
#[tokio::test]
async fn a_pull_failure_outranks_a_push_watermark_from_the_same_cycle() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("local.md"), "local body").unwrap();
    let state = connected("");
    let server = FaultServer::new()
        .note(&state.vault_key, "peer", 5, "peer.md", "peer body")
        .fail_blob_of("peer", When::Always, Fault::Status(500))
        .start();
    let mut state = ConnectedState {
        base_url: server.base_url.clone(),
        ..state
    };
    // A non-zero watermark keeps the cycle out of first-sync reconciliation, so
    // push runs before the pull that fails.
    state.max_version = 1;
    state.pull_cursor = 1;

    let (summary, next) = cycle(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.uploaded, 1, "the push half must have succeeded");
    assert!(
        next.max_version > 1,
        "the create response must have advanced a watermark during push"
    );
    assert_eq!(
        next.pull_cursor, 4,
        "the failed remote change must be re-listed despite the push watermark"
    );
}

// Follow-up case 4.
#[tokio::test]
async fn unverifiable_tombstone_keeps_ancestry_and_caps_the_cursor() {
    let root = TempRoot::new();
    // A directory where the note belongs: the tombstone can claim it but can
    // never read its bytes, so the deletion is unverifiable rather than applied.
    std::fs::create_dir(root.path().join("note.md")).unwrap();
    write_ancestry(root.path(), "note.md", "gone", &hash_sha256("note body"));
    let state = connected("");
    let server = FaultServer::new()
        .note(&state.vault_key, "peer", 9, "peer.md", "peer body")
        .tombstone("gone", 5)
        .start();
    let state = ConnectedState {
        base_url: server.base_url.clone(),
        ..state
    };

    let (summary, next) = pull(&state, root.path(), 0, &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(
        summary.deleted, 0,
        "an unverifiable delete is not convergence"
    );
    assert_eq!(download_failures(&summary), 1);
    assert!(root.path().join("note.md").is_dir());
    assert_eq!(
        next.pull_cursor, 4,
        "the cursor must stay behind the tombstone so it is retried"
    );
    assert!(
        root.path().join(".e2ee-ancestry.json").exists(),
        "ancestry must survive for the retry that can still verify the delete"
    );
}

// Follow-up case 5. Unix-only: the fault is an injected directory-sync failure.
#[cfg(unix)]
#[tokio::test]
async fn tombstone_cleanup_failure_still_reports_the_parked_note() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("note.md"), "local edit").unwrap();
    write_ancestry(root.path(), "note.md", "gone", &hash_sha256("old base"));
    let state = connected("");
    let server = FaultServer::new().tombstone("gone", 5).start();
    let state = ConnectedState {
        base_url: server.base_url.clone(),
        ..state
    };
    // Directory syncs on the park path, in order: the sidecar write, both sides
    // of the claim rename, the conflict-name probe, both sides of the park
    // rename, and finally the sidecar cleanup this test fails.
    super::vault_fs::fail_directory_sync_on_call(7);

    let (summary, next) = pull(&state, root.path(), 0, &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(
        summary.conflicts, 1,
        "the parked note must be reported even though cleanup failed"
    );
    let parked = summary
        .updated_ids
        .first()
        .expect("the parked copy must be named in the summary");
    assert_eq!(
        std::fs::read_to_string(root.path().join(format!("{parked}.md"))).unwrap(),
        "local edit"
    );
    assert_eq!(download_failures(&summary), 1);
    assert_eq!(next.pull_cursor, 4);
}

// Follow-up case 6.
#[tokio::test]
async fn create_failure_reaches_the_public_summary_with_its_status() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("new.md"), "new body").unwrap();
    let server = FaultServer::new()
        .fail(Route::CreateObject, When::Always, Fault::Status(500))
        .start();
    let state = connected(&server.base_url);

    let (summary, next) = push(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(summary.uploaded, 0);
    assert_eq!(summary.failures.len(), 1);
    assert_eq!(summary.failures[0].kind, FailureKind::Upload);
    assert_eq!(summary.failures[0].status_code, Some(500));
    assert_eq!(
        summary.failure_message().as_deref(),
        Some("1 change couldn't reach the server (HTTP 500)")
    );
    assert!(
        !next.object_map.contains_key("new.md"),
        "a rejected create must not be recorded as synced"
    );
}

// Follow-up case 7.
#[tokio::test]
async fn restart_between_push_persistence_and_pull_still_receives_the_peer_change() {
    let root = TempRoot::new();
    std::fs::write(root.path().join("local.md"), "local body").unwrap();
    let state = connected("");
    let server = FaultServer::new()
        .note(&state.vault_key, "peer", 7, "peer.md", "peer body")
        .fail(Route::ListObjects, When::Nth(1), Fault::Status(500))
        .start();
    let mut state = ConnectedState {
        base_url: server.base_url.clone(),
        ..state
    };
    state.max_version = 1;
    state.pull_cursor = 1;

    cycle(&state, root.path(), &no_progress, &no_pre_write)
        .await
        .expect_err("the injected list failure must cut the cycle short after push");

    // Only what push persisted survives the restart.
    let restarted = restart_from_checkpoint(root.path(), &state);
    assert!(
        restarted.object_map.contains_key("local.md"),
        "the completed upload must be in the persisted checkpoint"
    );

    let (summary, next) = cycle(&restarted, root.path(), &no_progress, &no_pre_write)
        .await
        .unwrap();

    assert_eq!(
        std::fs::read_to_string(root.path().join("peer.md")).unwrap(),
        "peer body",
        "the peer change must still be delivered after the restart"
    );
    assert_eq!(summary.downloaded, 1);
    assert_eq!(next.pull_cursor, 7);
    assert_eq!(
        server.requests(Route::CreateObject),
        1,
        "the restart must not re-upload the note push already created"
    );
}
