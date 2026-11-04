//! Portable page + store host merge adoption and baseline handling.
use super::*;

#[test]
fn portable_clean_checkpoint_leaves_page_owned_source_and_history_unchanged() {
    use futo_notes_editor::{PortableSession, SessionToken};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(325))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let edit = page.replace(Revision(0), range(0, 0), "local ").unwrap();
    page.acknowledge(host.handle(edit.request)).unwrap();
    host.checkpoint().unwrap();
    store
        .write("plain", "local first\n\npeer second\n", None)
        .unwrap();
    assert_eq!(
        host.checkpoint().unwrap().disposition,
        FlushDisposition::Converged
    );
    assert_eq!(host.snapshot().source, "local first\n\nsecond\n");
    assert_eq!(page.draft_text(), "local first\n\nsecond\n");
    let undo = page.undo(Revision(1)).unwrap().unwrap();
    page.acknowledge(host.handle(undo.request)).unwrap();
    assert_eq!(page.draft_text(), "first\n\nsecond\n");
    assert_eq!(store.read("plain").unwrap(), "local first\n\npeer second\n");
}

#[test]
fn portable_merge_checkpoint_records_the_baseline_so_undo_saves_in_place() {
    use futo_notes_editor::{PortableSession, SessionToken};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(574))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let edit = page.replace(Revision(0), range(7, 13), "LOCAL").unwrap();
    page.acknowledge(host.handle(edit.request)).unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    let merged = host.checkpoint_merged().unwrap();
    assert_eq!(merged.source, "REMOTE\n\nLOCAL\n");
    let adoption = page
        .adopt_merged_source(Revision(1), &merged.source)
        .unwrap();
    page.acknowledge(host.handle(adoption.request)).unwrap();
    let undo = page.undo(Revision(2)).unwrap().unwrap();
    page.acknowledge(host.handle(undo.request)).unwrap();
    let result = host.checkpoint().unwrap();
    assert_eq!(result.disposition, FlushDisposition::Wrote);
    assert_eq!(host.id(), "plain");
    assert_eq!(store.read("plain").unwrap(), "REMOTE\n\nsecond\n");
}

#[test]
fn portable_merge_never_overwrites_the_peer_when_the_page_does_not_adopt() {
    use futo_notes_editor::{PortableSession, SessionToken};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(575))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let edit = page.replace(Revision(0), range(7, 13), "LOCAL").unwrap();
    page.acknowledge(host.handle(edit.request)).unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    let merged = host.checkpoint_merged().unwrap();
    assert_eq!(merged.source, "REMOTE\n\nLOCAL\n");
    // The page refused or never received the adoption: the worker still holds
    // the unmerged draft, and the next save must not overwrite the merge.
    let result = host.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = result.disposition else {
        panic!("an undelivered merge must preserve both versions")
    };
    assert_eq!(store.read("plain").unwrap(), "REMOTE\n\nLOCAL\n");
    assert_eq!(store.read(&parked_id).unwrap(), "first\n\nLOCAL\n");
}

#[test]
fn portable_undo_before_a_merge_is_adopted_is_not_reported_saved() {
    use futo_notes_editor::{PortableSession, SessionToken};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(576))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let edit = page.replace(Revision(0), range(7, 13), "LOCAL").unwrap();
    page.acknowledge(host.handle(edit.request)).unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    host.checkpoint_merged().unwrap();
    let undo = page.undo(Revision(1)).unwrap().unwrap();
    page.acknowledge(host.handle(undo.request)).unwrap();
    assert!(matches!(
        host.checkpoint().unwrap().disposition,
        FlushDisposition::ParkedConflict { .. }
    ));
    assert_eq!(store.read("plain").unwrap(), "REMOTE\n\nLOCAL\n");
}
