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

/// The page's exchange: send the request, hand the host's ack back.
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
fn close_saves_accepted_edits_and_reopening_reads_them() {
    let (root, store) = vault("ab\n");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store);
    assert_eq!(opened.snapshot.source, "ab\n");
    assert_eq!(opened.note_ids, ["plain"]);
    let edit = page.replace(Revision(0), at(2), "c").unwrap().request;
    let ack = exchange(&hosts, opened.token, &mut page, edit);
    assert_eq!((ack.accepted, ack.error), (Revision(1), None));
    // Accepting an edit writes nothing; the save timer or close does.
    assert_eq!(
        store.read_existing("plain").unwrap().as_deref(),
        Some("ab\n")
    );

    hosts.close(opened.token).unwrap();
    assert_eq!(
        store.read_existing("plain").unwrap().as_deref(),
        Some("abc\n")
    );
    let (reopened, _) = open(&hosts, &store);
    assert_eq!(reopened.snapshot.source, "abc\n");
    assert_ne!(reopened.token, opened.token);
    hosts.close_all();
    assert!(!root.join(".futo-editor-recovery").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn checkpoint_saves_now_and_failed_close_keeps_the_note_attached() {
    let (root, store) = vault("ab\n");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store);
    let edit = page.replace(Revision(0), at(2), "c").unwrap().request;
    exchange(&hosts, opened.token, &mut page, edit);
    hosts.checkpoint(opened.token).unwrap();
    assert_eq!(
        store.read_existing("plain").unwrap().as_deref(),
        Some("abc\n")
    );

    // A directory where the note file belongs makes the next save fail.
    let edit = page.replace(Revision(1), at(3), "d").unwrap().request;
    exchange(&hosts, opened.token, &mut page, edit);
    let note = root.join("plain.md");
    std::fs::remove_file(&note).unwrap();
    std::fs::create_dir(&note).unwrap();
    assert!(hosts.close(opened.token).is_err());
    // Still attached: the lease is held and requests are still routed.
    assert!(store.open_editor("plain").is_err());
    let edit = page.replace(Revision(2), at(4), "e").unwrap().request;
    let ack = exchange(&hosts, opened.token, &mut page, edit);
    assert_eq!(ack.accepted, Revision(3));
    std::fs::remove_dir(&note).unwrap();
    hosts.close(opened.token).unwrap();
    assert_eq!(
        store.read_existing("plain").unwrap().as_deref(),
        Some("abcde\n")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_tokens_are_refused_and_close_releases_the_lease() {
    let (root, store) = vault("ab\n");
    let hosts = EditorHostState::default();
    let (first, mut page) = open(&hosts, &store);
    // A second store handle cannot attach while the host holds the lease.
    assert!(store.open_editor("plain").is_err());
    let (second, _) = open(&hosts, &store);
    let edit = page.replace(Revision(0), at(0), "x").unwrap().request;
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
    let (root, store) = vault("ab\n");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store);
    let edit = page.replace(Revision(0), at(2), "c").unwrap().request;
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
fn worker_saves_when_the_timer_fires_and_reports_it() {
    let (root, store) = vault("ab\n");
    let hosts = EditorHostState::default();
    let (saved_tx, saved) = mpsc::channel();
    let opened = hosts
        .open(store.clone(), "plain".into(), move |event| {
            let _ = saved_tx.send(event);
        })
        .unwrap();
    let mut page = PortableSession::from_snapshot(opened.snapshot.clone()).unwrap();
    let edit = page.replace(Revision(0), at(2), "c").unwrap().request;
    exchange(&hosts, opened.token, &mut page, edit);
    let event = saved.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(event.token, opened.token);
    assert_eq!(event.error, None);
    assert!(event.result.is_some());
    assert_eq!(
        store.read_existing("plain").unwrap().as_deref(),
        Some("abc\n")
    );
    // Clean now: the timer does not fire again.
    assert!(saved.recv_timeout(Duration::from_millis(700)).is_err());
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn saved_event_serializes_token_result_and_error() {
    let event = EditorSaved {
        token: 7,
        result: None,
        error: Some("disk full".into()),
    };
    assert_eq!(
        serde_json::to_value(&event).unwrap(),
        serde_json::json!({"token": 7, "result": null, "error": "disk full"})
    );
}
