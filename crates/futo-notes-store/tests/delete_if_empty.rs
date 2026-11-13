//! `LocalNoteStore::delete_if_empty` (#391): the untouched-new-note discard must not delete
//! a note a peer wrote to meanwhile.
use futo_notes_store::LocalNoteStore;
use std::sync::{Arc, Barrier};

fn vault() -> (tempfile::TempDir, LocalNoteStore) {
    let root = tempfile::tempdir().unwrap();
    let store = LocalNoteStore::new(root.path().to_owned());
    (root, store)
}

/// A kept note's mutation is still a complete shell projection: iOS's
/// `applyMutation` assigns `folders = mutation.folders` wholesale.
#[test]
fn a_kept_note_still_reports_the_vaults_folders() {
    let (_root, store) = vault();
    store.create("Projects", "plan", "p\n").unwrap();
    store.create("", "note", "").unwrap();
    std::fs::write(_root.path().join("note.md"), "the peer's words\n").unwrap();
    let kept = store.delete_if_empty("note").unwrap();
    assert!(kept.removed.is_empty());
    assert_eq!(store.read("note").unwrap(), "the peer's words\n");
    assert_eq!(
        kept.folders,
        vec!["Projects".to_owned()],
        "kept-note mutation wiped the folder list"
    );
}

#[test]
fn only_a_zero_byte_note_counts_as_empty() {
    let (root, store) = vault();
    for (name, body, deleted) in [
        ("empty", "", true),
        ("newline", "\n", false),
        ("crlf", "\r\n", false),
        ("spaces", "   ", false),
        ("text", "words\n", false),
    ] {
        store.create("", name, "").unwrap();
        std::fs::write(root.path().join(format!("{name}.md")), body).unwrap();
        let m = store.delete_if_empty(name).unwrap();
        assert_eq!(m.removed.is_empty(), !deleted, "{name}");
        assert_eq!(
            store.read_existing(name).unwrap().is_none(),
            deleted,
            "{name}"
        );
    }
    // Folder note, missing note.
    store.create("A/B", "deep", "").unwrap();
    assert_eq!(
        store.delete_if_empty("A/B/deep").unwrap().removed,
        ["A/B/deep"]
    );
    assert!(store.delete_if_empty("never").unwrap().removed.is_empty());
}

#[test]
fn an_unreadable_note_is_kept_and_the_delete_errors() {
    let (root, store) = vault();
    store.create("", "bin", "").unwrap();
    std::fs::write(root.path().join("bin.md"), [0xff, 0xfe, 0x00]).unwrap();
    assert!(store.delete_if_empty("bin").is_err());
    assert!(root.path().join("bin.md").exists());
}

/// A writer and the conditional delete race: whatever the order, the writer's
/// words end up on disk (either the delete saw them and kept the note, or it
/// ran first and the write recreated it).
fn race(rounds: usize) -> usize {
    let mut lost = 0;
    for _ in 0..rounds {
        let (_root, store) = vault();
        store.create("", "note", "").unwrap();
        let store = Arc::new(store);
        let gate = Arc::new(Barrier::new(2));
        let (s, g) = (store.clone(), gate.clone());
        let writer = std::thread::spawn(move || {
            g.wait();
            // A peer's write that goes through the engine only if the note exists
            // (an in-place sync update): append fails on a missing note.
            s.append("note", "x\n")
        });
        gate.wait();
        let deleted = store.delete_if_empty("note").unwrap();
        let appended = writer.join().unwrap();
        // The writer's words were accepted onto the note, then the note vanished.
        if appended.is_ok() && store.read_existing("note").unwrap().is_none() {
            assert!(!deleted.removed.is_empty());
            lost += 1;
        }
    }
    lost
}

#[test]
fn a_racing_peer_write_is_never_deleted() {
    assert_eq!(race(200), 0);
}
