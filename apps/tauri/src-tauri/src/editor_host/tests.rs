use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::time::Duration;

use futo_notes_editor::{DisplayOffset, DisplayRange, PortableSession, Revision};

use super::*;

fn at(offset: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(offset),
        end: DisplayOffset(offset),
    }
}

fn vault(source: &str) -> (PathBuf, Arc<LocalNoteStore>) {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let root = std::env::temp_dir().join(format!(
        "futo-notes-tauri-editor-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    let store = Arc::new(LocalNoteStore::new(root.clone()));
    store.create("", "plain", source).unwrap();
    (root, store)
}

fn open(hosts: &EditorHostState, store: &Arc<LocalNoteStore>) -> (EditorOpened, PortableSession) {
    let opened = hosts.open(store.clone(), "plain".into(), |_| {}).unwrap();
    let page = PortableSession::from_snapshot(opened.snapshot.clone()).unwrap();
    (opened, page)
}

/// The page's ordered exchange: request, host ack, release.
fn exchange(
    hosts: &EditorHostState,
    token: u64,
    page: &mut PortableSession,
    request: HostRequest,
) -> HostAck {
    let ack = hosts.request(token, request).unwrap();
    page.acknowledge(ack.clone()).unwrap();
    ack
}

#[test]
fn accepted_edits_flush_checkpoint_and_replay_after_reopening() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store);
    assert_eq!(opened.snapshot.source, "ab");
    assert_eq!(opened.note_ids, ["plain"]);
    let edit = page.replace(Revision(0), at(2), "c").unwrap();
    let ack = exchange(&hosts, opened.token, &mut page, edit);
    assert_eq!(
        (ack.accepted, ack.durable, ack.error),
        (Revision(1), Revision(0), None)
    );
    let flush = page.flush().unwrap();
    assert_eq!(
        exchange(&hosts, opened.token, &mut page, flush).durable,
        Revision(1)
    );

    // Closing without a checkpoint keeps the draft recoverable, not saved.
    hosts.close(opened.token).unwrap();
    assert_eq!(store.read_existing("plain").unwrap().as_deref(), Some("ab"));
    let (reopened, _) = open(&hosts, &store);
    assert_eq!(reopened.snapshot.source, "abc");
    assert_ne!(reopened.token, opened.token);
    hosts.checkpoint(reopened.token).unwrap();
    assert_eq!(
        store.read_existing("plain").unwrap().as_deref(),
        Some("abc")
    );
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_committed_checkpoint_reaches_the_page_with_its_mutation() {
    let result = FlushDraftResult {
        disposition: futo_notes_store::FlushDisposition::Wrote,
        mutation: None,
    };
    let committed = EditorCheckpointError::from(EditorStoreError::CheckpointCommitted {
        result: Box::new(result.clone()),
        error: "retire failed".into(),
    });
    assert_eq!(
        committed,
        EditorCheckpointError::Committed {
            result,
            message: "retire failed".into()
        }
    );
    assert_eq!(
        serde_json::to_value(&committed).unwrap(),
        serde_json::json!({
            "kind": "committed",
            "result": {"disposition": {"kind": "wrote"}, "mutation": null},
            "message": "retire failed",
        })
    );
    let failed = EditorCheckpointError::from(EditorStoreError::CheckpointPending);
    assert_eq!(
        serde_json::to_value(&failed).unwrap(),
        serde_json::json!({"kind": "failed", "message": "CheckpointPending"})
    );
}

#[test]
fn stale_tokens_are_refused_and_close_releases_the_lease() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (first, mut page) = open(&hosts, &store);
    // A second store handle cannot attach while the host holds the lease.
    assert!(store.open_editor("plain").is_err());
    let (second, _) = open(&hosts, &store);
    let edit = page.replace(Revision(0), at(0), "x").unwrap();
    assert_eq!(
        hosts.request(first.token, edit.clone()),
        Err("stale editor session".into())
    );
    assert_eq!(
        hosts.checkpoint(first.token).unwrap_err(),
        EditorCheckpointError::Failed {
            message: "stale editor session".into()
        }
    );
    assert!(hosts.close(first.token).is_err());
    // A request carrying the old token through the live route is refused by Store.
    let ack = hosts.request(second.token, edit.clone()).unwrap();
    assert_eq!(ack.accepted, Revision(0));
    assert!(ack.error.is_some());

    hosts.close(second.token).unwrap();
    assert_eq!(
        hosts.request(second.token, edit),
        Err("no note is attached to the editor".into())
    );
    drop(store.open_editor("plain").unwrap());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn legacy_save_is_refused_while_attached() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store);
    let edit = page.replace(Revision(0), at(2), "c").unwrap();
    exchange(&hosts, opened.token, &mut page, edit);
    // The Store refuses by lease, under its gate, whatever the key's case.
    let refusal = store.save_unattached(None, "PLAIN", "x", None).unwrap_err();
    assert!(refusal.contains("editor_checkpoint"), "{refusal}");
    store
        .flush_draft_unattached("Plain", "ab", "abc")
        .unwrap_err();
    store.save_unattached(None, "Other", "x", None).unwrap();
    hosts.close_all();
    store
        .save_unattached(Some("plain"), "plain", "x", None)
        .unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn worker_signals_a_due_flush_that_the_page_performs() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (due_tx, due) = mpsc::channel();
    let opened = hosts
        .open(store.clone(), "plain".into(), move |token| {
            let _ = due_tx.send(token);
        })
        .unwrap();
    let mut page = PortableSession::from_snapshot(opened.snapshot.clone()).unwrap();
    let edit = page.replace(Revision(0), at(2), "c").unwrap();
    exchange(&hosts, opened.token, &mut page, edit);
    // The timer only tells the page; durability still needs its Flush.
    let token = due.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(token.0, opened.token);
    assert!(due.recv_timeout(Duration::from_millis(300)).is_err());
    assert_eq!(page.status().durable, Revision(0));
    let flush = page.flush().unwrap();
    assert_eq!(
        exchange(&hosts, opened.token, &mut page, flush).durable,
        Revision(1)
    );

    let edit = page.replace(Revision(1), at(3), "d").unwrap();
    exchange(&hosts, opened.token, &mut page, edit);
    hosts.close(opened.token).unwrap();
    let (reopened, _) = open(&hosts, &store);
    assert_eq!(reopened.snapshot.source, "abcd");
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_recovered_draft_signals_its_flush_without_a_request() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store);
    let edit = page.replace(Revision(0), at(2), "c").unwrap();
    exchange(&hosts, opened.token, &mut page, edit);
    hosts.close(opened.token).unwrap();

    let (due_tx, due) = mpsc::channel();
    let reopened = hosts
        .open(store.clone(), "plain".into(), move |token| {
            let _ = due_tx.send(token);
        })
        .unwrap();
    assert_eq!(reopened.snapshot.source, "abc");
    // The replayed edit is accepted but not durable; no request has arrived.
    let token = due.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(token.0, reopened.token);
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}
