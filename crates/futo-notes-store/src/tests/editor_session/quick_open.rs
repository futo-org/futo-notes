use super::*;
use futo_notes_editor::{shown_projection, QUICK_OPEN_BYTES};

/// The quick open's first screen against the whole open of the same note.
fn agrees_with_open(store: &LocalNoteStore, id: &str) -> usize {
    let quick = store
        .quick_open_editor(id)
        .unwrap()
        .expect("a first screen");
    let session = store.open_editor(id).unwrap();
    let display = session.display_text();
    assert!(display.starts_with(&quick.display));
    let range = range(0, quick.display.len());
    let mut whole = shown_projection(session.project(session.revision(), range).unwrap());
    whole.revision = quick.projection.revision;
    assert_eq!(whole, quick.projection);
    assert_eq!(
        session.inspect_tables(session.revision(), range).unwrap(),
        quick.tables
    );
    quick.display.len()
}

#[test]
fn a_long_note_shows_the_first_screen_its_session_will_show() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("Projects", "Roadmap", "").unwrap();
    // Wikilinks resolve against the vault's ids; a multi-byte character
    // straddles the read so the head is cut back to a whole character.
    let mut body = String::from("# Plan\n\nSee [[Roadmap]] and [a link](https://x.test).\n\n");
    while body.len() < QUICK_OPEN_BYTES - 1 {
        body += "| a | b |\n|---|---|\n| 1 | **2** |\n\n- item\n- [ ] task\n\n";
    }
    body.truncate(QUICK_OPEN_BYTES - 1);
    body += "é tail\n\nmore\n";
    body += &"para\n\n".repeat(2000);
    plant_note(&root, "long", &body);
    let shown = agrees_with_open(&store, "long");
    assert!(shown > QUICK_OPEN_BYTES / 2, "{shown}");
    assert!(store
        .quick_open_editor("long")
        .unwrap()
        .unwrap()
        .projection
        .wikilinks[0]
        .note_id
        .is_some());
}

#[test]
fn a_definition_anywhere_after_the_cut_declines_a_first_screen_that_could_use_it() {
    let root = TestRoot::new();
    let store = store(&root);
    let mut body = "See [it] here.\n\n".repeat(QUICK_OPEN_BYTES / 16 + 1);
    body += &"para\n\n".repeat(20_000);
    plant_note(&root, "plain", &body);
    agrees_with_open(&store, "plain");

    // Far past the read.
    let seam = QUICK_OPEN_BYTES + 1 + 64 * 1024;
    body.truncate(seam - 1);
    body += "]: https://example.com\n";
    plant_note(&root, "defined", &body);
    assert_eq!(store.quick_open_editor("defined").unwrap(), None);
}

#[test]
fn a_short_or_missing_note_has_no_quick_open() {
    let root = TestRoot::new();
    let store = store(&root);
    plant_note(&root, "short", &"para\n\n".repeat(100));
    assert_eq!(store.quick_open_editor("short").unwrap(), None);
    assert_eq!(store.quick_open_editor("missing").unwrap(), None);
    assert!(store.quick_open_editor("../escape").is_err());
}
