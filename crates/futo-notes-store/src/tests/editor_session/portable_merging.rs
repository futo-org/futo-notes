//! Portable saves merge three ways and offer the merge to the page.
use super::*;
use futo_notes_editor::{PortableSession, SessionToken};

fn portable<'store>(
    store: &'store LocalNoteStore,
    id: &str,
    token: u64,
) -> (StoreEditorHost<'store>, PortableSession) {
    let host = store
        .open_editor(id)
        .unwrap()
        .into_portable_host(SessionToken(token))
        .unwrap();
    let page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    (host, page)
}

/// `first\n\nsecond\n` with `second` typed over as `LOCAL` (revision 1) and the
/// first line rewritten outside: the first save merges and offers the merge.
fn merged_outside_edit<'store>(
    store: &'store LocalNoteStore,
    token: u64,
) -> (StoreEditorHost<'store>, PortableSession) {
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let (mut host, mut page) = portable(store, "plain", token);
    let edit = page
        .replace(Revision(0), range(7, 13), "LOCAL")
        .unwrap()
        .unwrap();
    page.acknowledge(host.handle(edit.request)).unwrap();
    store.write("plain", "REMOTE\n\nsecond\n", None).unwrap();
    let save = host.checkpoint().unwrap();
    assert_eq!(save.flush.disposition, FlushDisposition::Wrote);
    assert_eq!(save.offered.as_deref(), Some("REMOTE\n\nLOCAL\n"));
    assert_eq!(store.read("plain").unwrap(), "REMOTE\n\nLOCAL\n");
    (host, page)
}

fn adopt(host: &mut StoreEditorHost<'_>, page: &mut PortableSession, at: u64, source: &str) {
    let adoption = page.adopt_merged_source(Revision(at), source).unwrap();
    page.acknowledge(host.handle(adoption.request)).unwrap();
}

fn undo(host: &mut StoreEditorHost<'_>, page: &mut PortableSession, at: u64) {
    let undo = page.undo(Revision(at)).unwrap().unwrap();
    page.acknowledge(host.handle(undo.request)).unwrap();
}

fn note_sources(store: &LocalNoteStore) -> Vec<String> {
    let mut sources: Vec<String> = store
        .snapshot()
        .notes
        .iter()
        .map(|note| store.read(&note.id).unwrap())
        .collect();
    sources.sort();
    sources
}

#[test]
fn portable_typing_past_an_undelivered_merge_merges_again_without_a_copy() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first middle last\n").unwrap();
    let (mut host, mut page) = portable(&store, "plain", 601);
    let edit = page
        .replace(Revision(0), range(13, 17), "LOCAL")
        .unwrap()
        .unwrap();
    page.acknowledge(host.handle(edit.request)).unwrap();
    store.write("plain", "REMOTE middle last\n", None).unwrap();
    let first = host.checkpoint().unwrap();
    assert_eq!(first.offered.as_deref(), Some("REMOTE middle LOCAL\n"));
    assert_eq!(store.read("plain").unwrap(), "REMOTE middle LOCAL\n");
    let typed = page
        .replace(Revision(1), range(18, 18), "!")
        .unwrap()
        .unwrap();
    page.acknowledge(host.handle(typed.request)).unwrap();
    let second = host.checkpoint().unwrap();
    assert_eq!(second.flush.disposition, FlushDisposition::Wrote);
    assert_eq!(store.read("plain").unwrap(), "REMOTE middle LOCAL!\n");
    assert_eq!(second.offered.as_deref(), Some("REMOTE middle LOCAL!\n"));
    assert_eq!(store.snapshot().notes.len(), 1);
}

#[test]
fn portable_merge_offers_the_merge_and_the_adopted_append_makes_it_the_baseline() {
    let root = TestRoot::new();
    let store = store(&root);
    let (mut host, mut page) = merged_outside_edit(&store, 602);
    adopt(&mut host, &mut page, 1, "REMOTE\n\nLOCAL\n");
    let adopted = host.checkpoint().unwrap();
    assert_eq!(adopted.flush.disposition, FlushDisposition::Converged);
    assert_eq!(adopted.flush.mutation, None);
    assert_eq!(adopted.offered, None);
    undo(&mut host, &mut page, 2);
    let undone = host.checkpoint().unwrap();
    assert_eq!(undone.flush.disposition, FlushDisposition::Wrote);
    assert_eq!(host.id(), "plain");
    assert_eq!(store.read("plain").unwrap(), "REMOTE\n\nsecond\n");
}

#[test]
fn portable_save_of_an_unadopted_merge_writes_nothing_and_offers_it_again() {
    let root = TestRoot::new();
    let store = store(&root);
    let (mut host, _page) = merged_outside_edit(&store, 603);
    let again = host.checkpoint().unwrap();
    assert_eq!(again.flush.disposition, FlushDisposition::Converged);
    assert_eq!(again.flush.mutation, None);
    assert_eq!(again.offered.as_deref(), Some("REMOTE\n\nLOCAL\n"));
    assert_eq!(note_sources(&store), ["REMOTE\n\nLOCAL\n"]);
}

#[test]
fn portable_undo_before_a_merge_is_adopted_merges_the_undo_with_the_outside_edit() {
    let root = TestRoot::new();
    let store = store(&root);
    let (mut host, mut page) = merged_outside_edit(&store, 604);
    undo(&mut host, &mut page, 1);
    let undone = host.checkpoint().unwrap();
    assert_eq!(undone.flush.disposition, FlushDisposition::Wrote);
    assert_eq!(undone.offered.as_deref(), Some("REMOTE\n\nsecond\n"));
    assert_eq!(note_sources(&store), ["REMOTE\n\nsecond\n"]);
}

#[test]
fn portable_same_line_edits_park_and_offer_nothing() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "the cat rests\n").unwrap();
    let (mut host, mut page) = portable(&store, "plain", 605);
    let edit = page
        .replace(Revision(0), range(4, 7), "car")
        .unwrap()
        .unwrap();
    page.acknowledge(host.handle(edit.request)).unwrap();
    store.write("plain", "the bat rests\n", None).unwrap();
    let save = host.checkpoint().unwrap();
    let FlushDisposition::ParkedConflict { parked_id } = save.flush.disposition else {
        panic!("edits to the same word must keep both versions")
    };
    assert_eq!(save.offered, None);
    assert_eq!(host.id(), parked_id);
    assert_eq!(store.read("plain").unwrap(), "the bat rests\n");
    assert_eq!(store.read(&parked_id).unwrap(), "the car rests\n");
}

#[test]
fn portable_clean_checkpoint_offers_the_outside_source_and_writes_nothing() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n\nsecond\n").unwrap();
    let (mut host, page) = portable(&store, "plain", 606);
    store
        .write("plain", "first\n\npeer second\n", None)
        .unwrap();
    let file = root.0.join("plain.md");
    let written = fs::metadata(&file).unwrap().modified().unwrap();
    let save = host.checkpoint().unwrap();
    assert_eq!(save.flush.disposition, FlushDisposition::Converged);
    assert_eq!(save.flush.mutation, None);
    assert_eq!(save.offered.as_deref(), Some("first\n\npeer second\n"));
    assert_eq!(host.snapshot().source, "first\n\nsecond\n");
    assert_eq!(page.draft_text(), "first\n\nsecond\n");
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), written);
}

#[test]
fn portable_clean_offer_adopted_keeps_page_undo_and_saves_nothing_more() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "one two\n").unwrap();
    let (mut host, mut page) = portable(&store, "plain", 607);
    let typed = page
        .replace(Revision(0), range(7, 7), " three")
        .unwrap()
        .unwrap();
    page.acknowledge(host.handle(typed.request)).unwrap();
    host.checkpoint().unwrap();
    store.write("plain", "zero one two three\n", None).unwrap();
    let offer = host.checkpoint().unwrap().offered.unwrap();
    adopt(&mut host, &mut page, 1, &offer);
    let adopted = host.checkpoint().unwrap();
    assert_eq!(adopted.flush.disposition, FlushDisposition::Converged);
    undo(&mut host, &mut page, 2);
    host.checkpoint().unwrap();
    assert_eq!(note_sources(&store), ["zero one two\n"]);
}

#[test]
fn portable_clean_attachment_never_recreates_a_note_deleted_outside() {
    for offer_waiting in [false, true] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "plain", "first\n\nsecond\n").unwrap();
        let (mut host, _page) = portable(&store, "plain", 608);
        if offer_waiting {
            store.write("plain", "first\n\npeer\n", None).unwrap();
            assert!(host.checkpoint().unwrap().offered.is_some());
        }
        fs::remove_file(root.0.join("plain.md")).unwrap();
        let save = host.checkpoint().unwrap();
        assert_eq!(save.flush.disposition, FlushDisposition::Converged);
        assert_eq!(host.save_if_due().unwrap(), None);
        assert_eq!(
            host.close().unwrap().disposition,
            FlushDisposition::Converged
        );
        assert!(store.snapshot().notes.is_empty());
    }
}

#[test]
fn portable_dirty_draft_recreates_a_note_deleted_outside_and_says_so() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "first\n").unwrap();
    let (mut host, mut page) = portable(&store, "plain", 609);
    let typed = page
        .replace(Revision(0), range(5, 5), " typed")
        .unwrap()
        .unwrap();
    page.acknowledge(host.handle(typed.request)).unwrap();
    fs::remove_file(root.0.join("plain.md")).unwrap();
    let save = host.checkpoint().unwrap();
    assert_eq!(save.flush.disposition, FlushDisposition::Recreated);
    assert_eq!(save.offered, None);
    assert_eq!(store.read("plain").unwrap(), "first typed\n");
}

#[test]
fn portable_two_outside_edits_before_adoption_both_reach_the_file() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "a\n\nb\n\nc\n").unwrap();
    let (mut host, mut page) = portable(&store, "plain", 610);
    let edit = page
        .replace(Revision(0), range(6, 7), "C")
        .unwrap()
        .unwrap();
    page.acknowledge(host.handle(edit.request)).unwrap();
    store.write("plain", "A\n\nb\n\nc\n", None).unwrap();
    let first = host.checkpoint().unwrap();
    assert_eq!(first.offered.as_deref(), Some("A\n\nb\n\nC\n"));
    store.write("plain", "A\n\nB\n\nC\n", None).unwrap();
    let second = host.checkpoint().unwrap();
    assert_eq!(second.flush.disposition, FlushDisposition::Converged);
    assert_eq!(second.flush.mutation, None);
    assert_eq!(second.offered.as_deref(), Some("A\n\nB\n\nC\n"));
    adopt(&mut host, &mut page, 1, "A\n\nB\n\nC\n");
    let adopted = host.checkpoint().unwrap();
    assert_eq!(adopted.flush.disposition, FlushDisposition::Converged);
    assert_eq!(adopted.offered, None);
    assert_eq!(note_sources(&store), ["A\n\nB\n\nC\n"]);
}

#[test]
fn portable_front_matter_merge_is_written_even_though_the_page_cannot_adopt_it() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .create("", "plain", "---\ntitle: a\n---\nbody\n")
        .unwrap();
    let (mut host, mut page) = portable(&store, "plain", 611);
    let body_end = page.display_len() - 1;
    let edit = page
        .replace(Revision(0), range(body_end - 4, body_end), "BODY")
        .unwrap()
        .unwrap();
    page.acknowledge(host.handle(edit.request)).unwrap();
    assert_eq!(page.draft_text(), "---\ntitle: a\n---\nBODY\n");
    store
        .write("plain", "---\ntitle: b\n---\nbody\n", None)
        .unwrap();
    let merged = "---\ntitle: b\n---\nBODY\n";
    let save = host.checkpoint().unwrap();
    assert_eq!(save.offered.as_deref(), Some(merged));
    assert!(page.adopt_merged_source(Revision(1), merged).is_err());
    host.close().unwrap();
    assert_eq!(store.open_editor("plain").unwrap().source_text(), merged);
    assert_eq!(note_sources(&store), [merged]);
}

#[test]
fn portable_merge_stays_on_disk_when_the_host_stops_before_adoption() {
    let root = TestRoot::new();
    let store = store(&root);
    let (host, _page) = merged_outside_edit(&store, 613);
    drop(host);
    let reopened = store.open_editor("plain").unwrap();
    assert_eq!(reopened.source_text(), "REMOTE\n\nLOCAL\n");
    assert_eq!(store.snapshot().notes.len(), 1);
}

#[test]
fn portable_close_after_an_unadopted_merge_writes_the_merge_once() {
    let root = TestRoot::new();
    let store = store(&root);
    let (mut host, _page) = merged_outside_edit(&store, 614);
    let closed = host.close().unwrap();
    assert_eq!(closed.disposition, FlushDisposition::Converged);
    assert_eq!(closed.mutation, None);
    assert_eq!(note_sources(&store), ["REMOTE\n\nLOCAL\n"]);
}
