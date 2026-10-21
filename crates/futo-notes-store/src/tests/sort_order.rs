use super::*;

#[test]
fn the_note_list_orders_most_recently_modified_first_with_id_tiebreak() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("z", "", Some(5_000)).unwrap();
    store.write("a", "", Some(5_000)).unwrap();
    store.write("m", "", Some(5_000)).unwrap();
    store.write("old", "", Some(1_000)).unwrap();
    store.write("new", "", Some(9_000)).unwrap();
    assert_eq!(ids_in_order(&store), ["new", "a", "m", "z", "old"]);
}

// UTF-8 orders U+FDFD before U+1F600, opposite native UTF-16 comparison.
// The browser twin pins the same surrogate-range fixture.
#[test]
fn the_id_tiebreak_compares_utf8_bytes_across_the_surrogate_range() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("\u{1F600}", "", Some(5_000)).unwrap();
    store.write("\u{FDFD}", "", Some(5_000)).unwrap();
    assert_eq!(ids_in_order(&store), ["\u{FDFD}", "\u{1F600}"]);
}

fn name_order(direction: SortDirection) -> NoteSortOrder {
    NoteSortOrder {
        key: NoteSortKey::Name,
        direction,
    }
}

#[test]
fn the_default_sort_order_is_last_modified_newest_first() {
    assert_eq!(
        NoteSortOrder::default(),
        NoteSortOrder {
            key: NoteSortKey::LastModified,
            direction: SortDirection::Descending,
        }
    );
    let root = TestRoot::new();
    let store = store(&root);
    assert_eq!(store.sort_order(), NoteSortOrder::default());
}

#[test]
fn oldest_first_reverses_modified_time_and_keeps_the_id_tiebreak_ascending() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("z", "", Some(5_000)).unwrap();
    store.write("a", "", Some(5_000)).unwrap();
    store.write("old", "", Some(1_000)).unwrap();
    store.write("new", "", Some(9_000)).unwrap();
    store
        .set_sort_order(NoteSortOrder {
            key: NoteSortKey::LastModified,
            direction: SortDirection::Ascending,
        })
        .unwrap();
    assert_eq!(ids_in_order(&store), ["old", "a", "z", "new"]);
}

#[test]
fn name_order_is_case_insensitive_on_the_title_with_the_id_tiebreak() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("banana", "", Some(9_000)).unwrap();
    store.write("Cherry", "", Some(8_000)).unwrap();
    store.write("Sub/apple", "", Some(7_000)).unwrap();
    store.write("Apple", "", Some(1_000)).unwrap();

    store
        .set_sort_order(name_order(SortDirection::Ascending))
        .unwrap();
    assert_eq!(
        ids_in_order(&store),
        ["Apple", "Sub/apple", "banana", "Cherry"]
    );
    assert_eq!(
        store
            .startup_listing()
            .notes
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>(),
        ["Apple", "Sub/apple", "banana", "Cherry"]
    );

    store
        .set_sort_order(name_order(SortDirection::Descending))
        .unwrap();
    assert_eq!(
        ids_in_order(&store),
        ["Cherry", "banana", "Apple", "Sub/apple"]
    );
}

#[test]
fn mutation_positions_follow_the_active_sort_order() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .set_sort_order(name_order(SortDirection::Ascending))
        .unwrap();
    store.write("b", "", Some(1_000)).unwrap();
    store.write("a", "", Some(2_000)).unwrap();
    store.write("c", "", Some(3_000)).unwrap();

    let before = ids_in_order(&store);
    let inserted = store.write("Ab", "", Some(9_000)).unwrap();
    assert_eq!(inserted.upserted[0].position, 1);
    assert_eq!(apply_as_shell(&before, &inserted), ids_in_order(&store));

    let before = ids_in_order(&store);
    let edited = store.write("c", "edited", Some(10_000)).unwrap();
    assert_eq!(edited.upserted[0].position, 3);
    assert_eq!(apply_as_shell(&before, &edited), ids_in_order(&store));

    let before = ids_in_order(&store);
    let renamed = store.rename("c", "0first").unwrap();
    assert_eq!(apply_as_shell(&before, &renamed), ids_in_order(&store));
    assert_eq!(ids_in_order(&store), ["0first", "a", "Ab", "b"]);
}

#[test]
fn a_cached_listing_is_resorted_into_the_startup_order() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("b", "", Some(2_000)).unwrap();
    store.write("a", "", Some(1_000)).unwrap();
    let cached = store.startup_listing();
    let listing = store
        .startup_listing_in_order(name_order(SortDirection::Ascending), Some(cached))
        .unwrap();
    assert_eq!(
        listing
            .notes
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(store.sort_order(), name_order(SortDirection::Ascending));
}

#[test]
fn setting_the_sort_order_returns_the_vault_in_that_order() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("b", "", Some(2_000)).unwrap();
    store.write("a", "", Some(1_000)).unwrap();
    let snapshot = store
        .set_sort_order(name_order(SortDirection::Ascending))
        .unwrap();
    assert_eq!(
        snapshot
            .notes
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(ids_in_order(&store), ["a", "b"]);
}

#[test]
fn name_order_folds_titles_with_the_collision_rule() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("e\u{301}", "", Some(1_000)).unwrap();
    store.write("f", "", Some(2_000)).unwrap();
    store
        .set_sort_order(name_order(SortDirection::Ascending))
        .unwrap();
    assert_eq!(ids_in_order(&store), ["f", "e\u{301}"]);
}

#[test]
fn upserted_positions_index_into_the_post_mutation_sorted_snapshot() {
    let root = TestRoot::new();
    let store = store(&root);
    store.write("a", "1", Some(1_000)).unwrap();
    store.write("b", "2", Some(2_000)).unwrap();
    store.write("c", "3", Some(3_000)).unwrap();

    let edited = store.write("a", "1 edited", Some(4_000)).unwrap();
    assert_eq!(edited.final_id.as_deref(), Some("a"));
    assert_eq!(edited.upserted.len(), 1);
    assert_eq!(edited.upserted[0].position, 0);

    let mid = store.write("d", "4", Some(2_500)).unwrap();
    assert_eq!(mid.upserted[0].position, 2);
    assert_eq!(ids_in_order(&store), ["a", "c", "d", "b"]);
}

#[test]
fn applying_removals_then_position_splices_reproduces_the_snapshot_order() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .write("Lists/groceries", "self [[groceries]]", Some(1_000))
        .unwrap();
    store
        .write("pointer", "see [[groceries]]", Some(2_000))
        .unwrap();
    store.write("third", "unrelated", Some(3_000)).unwrap();

    let before = ids_in_order(&store);
    let renamed = store
        .rename("Lists/groceries", "Archive/groceries")
        .unwrap();
    assert_eq!(apply_as_shell(&before, &renamed), ids_in_order(&store));

    let before = ids_in_order(&store);
    let folder_deleted = store.delete_folder("Archive").unwrap();
    assert_eq!(
        apply_as_shell(&before, &folder_deleted),
        ids_in_order(&store)
    );

    let before = ids_in_order(&store);
    let deleted = store.delete("pointer").unwrap();
    assert_eq!(apply_as_shell(&before, &deleted), ids_in_order(&store));
}

#[test]
fn mutations_report_the_primary_notes_final_id() {
    let root = TestRoot::new();
    let store = store(&root);
    let created = store.create("", "Note", "one").unwrap();
    assert_eq!(created.final_id.as_deref(), Some("Note"));

    let collided = store.create("", "Note", "two").unwrap();
    assert_eq!(collided.final_id.as_deref(), Some("Note-2"));

    let written = store.write("Note", "three", None).unwrap();
    assert_eq!(written.final_id.as_deref(), Some("Note"));

    let renamed = store.rename("Note-2", "Renamed").unwrap();
    assert_eq!(renamed.final_id.as_deref(), Some("Renamed"));

    assert_eq!(store.delete("Renamed").unwrap().final_id, None);
    store.write("F/x", "", None).unwrap();
    assert_eq!(store.rename_folder("F", "G").unwrap().final_id, None);
    assert_eq!(store.delete_folder("G").unwrap().final_id, None);
}
