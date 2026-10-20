use super::*;

#[test]
fn a_write_stamps_the_modified_time_it_reports() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "first", None).unwrap();
    set_file_mtime_ms(&root.0.join("note.md"), 1_000).unwrap();

    let reported = store.write("note", "second", None).unwrap().upserted[0]
        .note
        .modified_ms;

    let on_disk = fs::metadata(root.0.join("note.md"))
        .and_then(|meta| meta.modified())
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    assert_eq!(reported, on_disk.as_millis() as i64);
    assert!(reported > 1_000);
    assert_eq!(
        on_disk.subsec_nanos() % 1_000_000,
        0,
        "the store must set the note's mtime itself, not inherit whatever the \
         filesystem left behind: a device whose rename does not advance the \
         timestamp otherwise reports a modified time the note does not have"
    );
}

#[test]
fn both_write_paths_honor_an_explicitly_supplied_modified_time() {
    let root = TestRoot::new();
    let store = store(&root);

    let installed = store
        .save(None, "fresh", "body", Some(1_600_000_000_000))
        .unwrap();
    let overwritten = store
        .write("fresh", "more", Some(1_700_000_000_000))
        .unwrap();

    assert_eq!(installed.upserted[0].note.modified_ms, 1_600_000_000_000);
    assert_eq!(overwritten.upserted[0].note.modified_ms, 1_700_000_000_000);
    assert_eq!(
        file_mtime_ms(&fs::metadata(root.0.join("fresh.md")).unwrap()),
        1_700_000_000_000
    );
}

#[test]
fn recent_note_ids_ignores_the_active_sort_order() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("apple", "a", Some(3_000)).unwrap();
    store.write("banana", "b", Some(1_000)).unwrap();
    store.write("Cherry", "c", Some(2_000)).unwrap();
    store
        .set_sort_order(NoteSortOrder {
            key: NoteSortKey::Name,
            direction: SortDirection::Ascending,
        })
        .unwrap();

    assert_eq!(
        store.recent_note_ids(2),
        vec!["apple".to_owned(), "Cherry".to_owned()]
    );
}

#[test]
fn a_title_change_moves_the_note_to_the_top_under_last_modified() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("old", "body", None).unwrap();
    set_file_mtime_ms(&root.0.join("old.md"), 1_000).unwrap();

    let renamed = store.rename("old", "new").unwrap();

    let reported = renamed
        .upserted
        .iter()
        .find(|entry| entry.note.id == "new")
        .expect("the renamed note is part of the mutation")
        .note
        .modified_ms;
    assert!(
        reported > 1_000,
        "a title change is a change [list.md]; rename alone never advances an \
         mtime, so the store has to"
    );
    assert_eq!(
        file_mtime_ms(&fs::metadata(root.0.join("new.md")).unwrap()),
        reported
    );
}

#[test]
fn moving_a_note_between_folders_keeps_its_modified_time() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("note", "body", None).unwrap();
    set_file_mtime_ms(&root.0.join("note.md"), 1_000).unwrap();

    let moved = store.move_note("note", "Archive").unwrap();

    assert_eq!(
        file_mtime_ms(&fs::metadata(root.0.join("Archive/note.md")).unwrap()),
        1_000,
        "a move keeps the note's title, so it is not a change to the note \
         [list.md] — only the folder it lives in moved"
    );
    assert_eq!(
        moved
            .upserted
            .iter()
            .find(|entry| entry.note.id == "Archive/note")
            .expect("the moved note is part of the mutation")
            .note
            .modified_ms,
        1_000
    );
}

#[test]
fn a_backlink_rewrite_keeps_the_rewritten_notes_own_modified_time() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("target", "body", None).unwrap();
    store.write("hub", "see [[target]]", None).unwrap();
    set_file_mtime_ms(&root.0.join("hub.md"), 1_000).unwrap();

    let renamed = store.rename("target", "renamed").unwrap();

    assert!(fs::read_to_string(root.0.join("hub.md"))
        .unwrap()
        .contains("[[renamed]]"));
    assert_eq!(
        file_mtime_ms(&fs::metadata(root.0.join("hub.md")).unwrap()),
        1_000,
        "nobody edited the hub note; rewriting its links must not move it to \
         the top [list.md]"
    );
    assert_eq!(
        renamed
            .upserted
            .iter()
            .find(|entry| entry.note.id == "hub")
            .expect("the relinked note is part of the mutation")
            .note
            .modified_ms,
        1_000
    );
}
