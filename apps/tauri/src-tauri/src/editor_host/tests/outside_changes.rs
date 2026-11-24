//! Saves of a note changed outside the app: merged and offered, parked, recreated.
use super::*;

#[test]
fn a_timer_save_merges_an_outside_edit_and_offers_it() {
    let (root, store) = vault("first\n\nsecond\n");
    let hosts = EditorHostState::default();
    let (emit, saved) = events();
    let opened = hosts
        .switch(store.clone(), "plain".into(), false, emit)
        .unwrap()
        .opened;
    let mut page = PortableSession::from_snapshot(opened.snapshot.clone()).unwrap();
    type_at_end(&hosts, opened.token, &mut page, "end");
    std::fs::write(root.join("plain.md"), "outside\n\nsecond\n").unwrap();
    let outcome = saved.recv_timeout(Duration::from_secs(5)).unwrap().outcome;
    let merged = "outside\n\nsecond\nend";
    assert!(outcome.saved && !outcome.parked);
    assert_eq!(outcome.offered.as_deref(), Some(merged));
    assert_eq!(outcome.note_id, "plain");
    assert_eq!(read(&store, "plain").as_deref(), Some(merged));
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_checkpoint_of_a_clean_note_offers_the_outside_source_and_writes_nothing() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, _page) = open(&hosts, &store, "plain");
    std::fs::write(root.join("plain.md"), "outside").unwrap();
    let outcome = hosts.checkpoint(opened.token).unwrap();
    assert_eq!(outcome.offered.as_deref(), Some("outside"));
    assert_eq!(outcome.mutation, None);
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_adopted_offer_is_saved_without_a_write() {
    let (root, store) = vault("first\n\nsecond\n");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    type_at_end(&hosts, opened.token, &mut page, "end");
    std::fs::write(root.join("plain.md"), "outside\n\nsecond\n").unwrap();
    let offer = hosts.checkpoint(opened.token).unwrap();
    let adoption = page
        .adopt_merged_source(offer.revision, offer.offered.as_deref().unwrap())
        .unwrap();
    exchange(&hosts, opened.token, &mut page, adoption.request);
    let adopted = hosts.checkpoint(opened.token).unwrap();
    assert_eq!(adopted.offered, None);
    assert_eq!(adopted.mutation, None);
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_same_line_outside_edit_parks_and_offers_nothing() {
    let (root, store) = vault("the cat");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    type_at_end(&hosts, opened.token, &mut page, "s");
    std::fs::write(root.join("plain.md"), "the cow").unwrap();
    let outcome = hosts.checkpoint(opened.token).unwrap();
    assert!(outcome.saved && outcome.parked);
    assert_eq!(outcome.offered, None);
    assert_ne!(outcome.note_id, "plain");
    assert_eq!(read(&store, &outcome.note_id).as_deref(), Some("the cats"));
    assert_eq!(read(&store, "plain").as_deref(), Some("the cow"));
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_save_after_an_outside_delete_reports_the_recreation() {
    let (root, store) = vault("ab");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    type_at_end(&hosts, opened.token, &mut page, "c");
    std::fs::remove_file(root.join("plain.md")).unwrap();
    let outcome = hosts.checkpoint(opened.token).unwrap();
    assert!(outcome.saved && outcome.recreated);
    assert_eq!(read(&store, "plain").as_deref(), Some("abc"));
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn reload_after_a_refused_offer_reads_the_merge() {
    let (root, store) = vault("---\ntitle: a\n---\nbody\n");
    let hosts = EditorHostState::default();
    let (opened, mut page) = open(&hosts, &store, "plain");
    let body_end = page.display_len() - 1;
    let edit = page
        .replace(
            page.status().local,
            DisplayRange {
                start: DisplayOffset(body_end - 4),
                end: DisplayOffset(body_end),
            },
            "BODY",
        )
        .unwrap()
        .unwrap();
    exchange(&hosts, opened.token, &mut page, edit.request);
    std::fs::write(root.join("plain.md"), "---\ntitle: b\n---\nbody\n").unwrap();
    let merged = "---\ntitle: b\n---\nBODY\n";
    let offer = hosts.checkpoint(opened.token).unwrap();
    assert_eq!(offer.offered.as_deref(), Some(merged));
    assert!(page.adopt_merged_source(offer.revision, merged).is_err());
    let reloaded = hosts.reload_token(opened.token).unwrap();
    assert_eq!(reloaded.opened.snapshot.source, merged);
    assert_eq!(read(&store, "plain").as_deref(), Some(merged));
    hosts.close_all();
    std::fs::remove_dir_all(root).unwrap();
}
