use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use futo_notes_editor::{DisplayOffset, DisplayRange, PortableSession};

use super::*;

mod outside_changes;

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
    // Planted as written: a store write would end them in a line ending.
    std::fs::write(root.join("plain.md"), source).unwrap();
    std::fs::write(root.join("other.md"), "other").unwrap();
    (root.clone(), Arc::new(LocalNoteStore::new(root)))
}

fn no_events() -> Emit {
    Arc::new(|_| {})
}

fn events() -> (Emit, Receiver<EditorSaved>) {
    let (sender, events) = mpsc::channel();
    let sender = Mutex::new(sender);
    let emit: Emit = Arc::new(move |event| {
        let _ = sender.lock().unwrap().send(event);
    });
    (emit, events)
}

fn open(
    hosts: &EditorHostState,
    store: &Arc<LocalNoteStore>,
    id: &str,
) -> (EditorOpened, PortableSession) {
    let opened = hosts
        .switch(store.clone(), id.into(), false, no_events())
        .unwrap()
        .opened;
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

/// Types `text` at the end of the page's draft: plain text, so its display is its source.
fn type_at_end(hosts: &EditorHostState, token: u64, page: &mut PortableSession, text: &str) {
    let end = page.draft_text().len();
    let edit = page
        .replace(page.status().local, at(end), text)
        .unwrap()
        .unwrap()
        .request;
    let ack = exchange(hosts, token, page, edit);
    assert_eq!(ack.error, None);
}

fn read(store: &LocalNoteStore, id: &str) -> Option<String> {
    store.read_existing(id).unwrap()
}

#[test]
fn close_saves_accepted_edits_and_reopening_reads_them() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    assert_eq!(
        (opened.note_id.as_str(), opened.snapshot.source.as_str()),
        ("plain", "ab")
    );
    type_at_end(&hosts, opened.token, &mut page, "c");
    // Accepting an edit writes nothing; the save timer or close does.
    assert_eq!(read(&store, "plain").as_deref(), Some("ab"));

    let closed = hosts.close(opened.token, false).unwrap();
    assert!(closed.saved && !closed.parked);
    assert_eq!(read(&store, "plain").as_deref(), Some("abc"));
    let (reopened, _) = open(&hosts, &store, "plain");
    assert_eq!(reopened.snapshot.source, "abc");
    assert_ne!(reopened.token, opened.token);
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_switch_opens_the_next_note_before_it_releases_the_previous() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    type_at_end(&hosts, opened.token, &mut page, "c");

    // The next note cannot open: nothing changes, the previous one stays attached.
    assert!(hosts
        .switch(store.clone(), "missing".into(), false, no_events())
        .is_err());
    type_at_end(&hosts, opened.token, &mut page, "d");
    assert_eq!(read(&store, "plain").as_deref(), Some("ab"));

    let switched = hosts
        .switch(store.clone(), "other".into(), false, no_events())
        .unwrap();
    assert_eq!(switched.opened.note_id, "other");
    let closed = switched.closed.unwrap();
    assert_eq!((closed.note_id.as_str(), closed.saved), ("plain", true));
    assert_eq!(read(&store, "plain").as_deref(), Some("abcd"));
    drop(store.open_editor("plain").unwrap());
    assert!(hosts.request(opened.token, page.resume().unwrap()).is_err());
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_failed_release_keeps_the_previous_note_and_drops_the_next() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    type_at_end(&hosts, opened.token, &mut page, "c");
    // A directory where the note file belongs makes its save fail.
    let note = root.join("plain.md");
    std::fs::remove_file(&note).unwrap();
    std::fs::create_dir(&note).unwrap();

    assert!(hosts
        .switch(store.clone(), "other".into(), false, no_events())
        .is_err());
    assert!(hosts.close(opened.token, false).is_err());
    // Still attached: requests are routed, and the next note's lease is free again.
    type_at_end(&hosts, opened.token, &mut page, "d");
    drop(store.open_editor("other").unwrap());

    std::fs::remove_dir(&note).unwrap();
    hosts.checkpoint(opened.token).unwrap();
    assert_eq!(read(&store, "plain").as_deref(), Some("abcd"));
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_discarding_switch_releases_the_previous_note_without_writing() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    type_at_end(&hosts, opened.token, &mut page, "c");
    let closed = hosts
        .switch(store.clone(), "other".into(), true, no_events())
        .unwrap()
        .closed
        .unwrap();
    assert!(!closed.saved);
    assert_eq!(read(&store, "plain").as_deref(), Some("ab"));
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

/// The store side (old name still there, chains, case-only, an own
/// recreation): futo-notes-store `tests/editor_session/outside_rename.rs`.
#[test]
fn a_rename_the_watcher_saw_is_reported_and_the_next_save_writes_there() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (emit, events) = events();
    let opened = hosts
        .switch(store.clone(), "plain".into(), false, emit)
        .unwrap()
        .opened;
    let mut page = PortableSession::from_snapshot(opened.snapshot.clone()).unwrap();
    type_at_end(&hosts, opened.token, &mut page, "c");
    std::fs::rename(root.join("plain.md"), root.join("finder.md")).unwrap();

    // What the file watcher's sink does before it emits `fs:change`.
    store.observe_external_change(futo_notes_store::FileChange::Renamed {
        from: "plain.md".into(),
        to: "finder.md".into(),
    });
    let moved = events.recv_timeout(Duration::from_secs(5)).unwrap().outcome;
    assert_eq!((moved.note_id.as_str(), moved.saved), ("finder", false));

    assert!(hosts.checkpoint(opened.token).unwrap().saved);
    assert_eq!(read(&store, "finder").as_deref(), Some("abc"));
    // Saved to the id it left, the store recreated it there: a ghost on every device.
    assert_eq!(read(&store, "plain"), None);
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn rename_saves_the_draft_under_the_new_id_and_the_attachment_follows() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    type_at_end(&hosts, opened.token, &mut page, "c");
    let renamed = hosts.rename(opened.token, "renamed".into()).unwrap();
    assert_eq!(renamed.note_id, "renamed");
    assert!(renamed.saved && !renamed.parked);
    assert_eq!(
        renamed.mutation.unwrap().final_id.as_deref(),
        Some("renamed")
    );
    assert_eq!(read(&store, "plain"), None);
    assert_eq!(read(&store, "renamed").as_deref(), Some("abc"));
    // Same token and sequence: later requests and checkpoints land under the new id.
    type_at_end(&hosts, opened.token, &mut page, "d");
    let saved = hosts.checkpoint(opened.token).unwrap();
    assert!(saved.stamp > renamed.stamp);
    assert_eq!(read(&store, "renamed").as_deref(), Some("abcd"));
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_store_move_of_the_attached_note_is_reported_in_order_with_its_saves() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (emit, events) = events();
    let opened = hosts
        .switch(store.clone(), "plain".into(), false, emit)
        .unwrap()
        .opened;
    let first = hosts.checkpoint(opened.token).unwrap();
    store.move_note("plain", "Archive").unwrap();
    let moved = events.recv_timeout(Duration::from_secs(5)).unwrap().outcome;
    assert_eq!(moved.note_id, "Archive/plain");
    assert!(moved.stamp > first.stamp && !moved.saved);
    let next = hosts.checkpoint(opened.token).unwrap();
    assert_eq!(next.note_id, "Archive/plain");
    assert!(next.stamp > moved.stamp);
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_switch_to_the_attached_note_saves_and_reads_it_back_under_a_new_token() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    hosts.checkpoint(opened.token).unwrap();
    std::fs::write(root.join("plain.md"), "outside").unwrap();
    let reloaded = hosts
        .switch(store.clone(), "plain".into(), false, no_events())
        .unwrap();
    assert_eq!(reloaded.opened.snapshot.source, "outside");
    // The old token's last outcome; the fresh draft's stamps start over.
    assert_eq!(reloaded.closed.unwrap().stamp, 2);
    assert!(hosts.request(opened.token, page.resume().unwrap()).is_err());
    let mut page = PortableSession::from_snapshot(reloaded.opened.snapshot.clone()).unwrap();
    type_at_end(&hosts, reloaded.opened.token, &mut page, "!");
    assert_eq!(hosts.checkpoint(reloaded.opened.token).unwrap().stamp, 1);
    hosts.close(reloaded.opened.token, false).unwrap();
    assert_eq!(read(&store, "plain").as_deref(), Some("outside!"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reload_reads_back_the_note_the_token_holds() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, _) = open(&hosts, &store, "plain");
    // A move the page has not heard of yet: the host reloads what it holds.
    store.move_note("plain", "Archive").unwrap();
    std::fs::write(root.join("Archive/plain.md"), "outside").unwrap();
    let reloaded = hosts.reload_token(opened.token).unwrap();
    assert_eq!(reloaded.opened.note_id, "Archive/plain");
    assert_eq!(reloaded.opened.snapshot.source, "outside");
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_switch_reloads_the_held_note_only_when_it_is_the_one_asked_for() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    type_at_end(&hosts, opened.token, &mut page, "c");
    // Another session holds "other": its lease refuses the open, and the note
    // the host holds is not the one asked for, so nothing changes.
    let elsewhere = store.open_editor("other").unwrap();
    assert!(hosts
        .switch(store.clone(), "other".into(), false, no_events())
        .is_err());
    drop(elsewhere);
    type_at_end(&hosts, opened.token, &mut page, "d");

    // Exactly the note held: reloaded, and with `discard` its unsaved draft is
    // dropped.
    let reloaded = hosts
        .switch(store.clone(), "plain".into(), true, no_events())
        .unwrap();
    assert!(!reloaded.closed.unwrap().saved);
    assert_eq!(reloaded.opened.snapshot.source, "ab");
    assert_eq!(read(&store, "plain").as_deref(), Some("ab"));

    // A case variant (a `[[PLAIN]]` link after an outside `PLAIN` -> `plain`
    // rename) is the held note where it is the same file: a volume that folds
    // case, as macOS does. On a case-sensitive one it is another note, refused.
    let one_file = root.join("PLAIN.md").exists();
    let variant = hosts.switch(store.clone(), "PLAIN".into(), false, no_events());
    assert_eq!(variant.is_ok(), one_file);
    if let Ok(variant) = variant {
        assert_eq!(variant.opened.note_id, "plain");
    }
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_tokens_are_refused_and_close_releases_the_lease() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (first, mut page) = open(&hosts, &store, "plain");
    // A second store handle cannot attach while the host holds the lease.
    assert!(store.open_editor("plain").is_err());
    let (second, _) = open(&hosts, &store, "other");
    let edit = page
        .replace(page.status().local, at(0), "x")
        .unwrap()
        .unwrap()
        .request;
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
    assert!(hosts.close(first.token, false).is_err());
    // A request carrying the old token through the live route is refused by Store.
    let ack = hosts.request(second.token, edit.clone()).unwrap();
    assert!(ack.error.is_some());

    hosts.close(second.token, false).unwrap();
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
    let (opened, mut page) = open(&hosts, &store, "plain");
    type_at_end(&hosts, opened.token, &mut page, "c");
    // The Store refuses by lease, under its gate, whatever the key's case.
    let refusal = store
        .save_unattached(Some("PLAIN"), "PLAIN", "x", None)
        .unwrap_err();
    assert!(refusal.contains("editor_checkpoint"), "{refusal}");
    store
        .save_unattached(Some("Plain"), "Plain", "abc", None)
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
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (emit, saved) = events();
    let opened = hosts
        .switch(store.clone(), "plain".into(), false, emit)
        .unwrap()
        .opened;
    let mut page = PortableSession::from_snapshot(opened.snapshot.clone()).unwrap();
    type_at_end(&hosts, opened.token, &mut page, "c");
    let event = saved.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        (event.token, event.outcome.error.clone()),
        (opened.token, None)
    );
    let outcome = event.outcome;
    assert!(outcome.saved);
    assert_eq!(outcome.revision, page.status().local);
    assert_eq!(read(&store, "plain").as_deref(), Some("abc"));
    // Clean now: the timer does not fire again.
    assert!(saved.recv_timeout(Duration::from_millis(700)).is_err());
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

/// A failed timer save is one stamped outcome like any other: the page orders
/// it against the saves, so a late failure never follows a save that landed.
#[test]
fn a_failed_timer_save_is_a_stamped_outcome() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (emit, saved) = events();
    let opened = hosts
        .switch(store.clone(), "plain".into(), false, emit)
        .unwrap()
        .opened;
    let mut page = PortableSession::from_snapshot(opened.snapshot.clone()).unwrap();
    type_at_end(&hosts, opened.token, &mut page, "c");
    // A directory where the note file belongs makes the timer's save fail.
    let note = root.join("plain.md");
    std::fs::remove_file(&note).unwrap();
    std::fs::create_dir(&note).unwrap();
    let failed = saved.recv_timeout(Duration::from_secs(5)).unwrap().outcome;
    assert!(failed.error.is_some() && !failed.saved);
    assert_eq!(failed.stamp, 1);
    std::fs::remove_dir(&note).unwrap();
    let next = hosts.checkpoint(opened.token).unwrap();
    assert_eq!((next.stamp, next.saved), (2, true));
    let json = serde_json::to_value(EditorSaved {
        token: 7,
        outcome: failed,
    })
    .unwrap();
    assert_eq!(json["outcome"]["stamp"], 1);
    assert!(json["outcome"]["error"].is_string());
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}
