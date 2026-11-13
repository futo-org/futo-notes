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

/// No reference definitions: a definition-shaped line after the cut is
/// literal text and the first screen still shows.
#[test]
fn a_definition_shaped_line_after_the_cut_changes_nothing_before_it() {
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
    agrees_with_open(&store, "defined");
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

/// Seeded: another writer changes the note between its read and its open
/// (#392). Unshown, the read changes nothing: the session opens on the file as
/// `open_editor` does, nothing is due and an edit saves in place. Shown, the
/// session opens on what was shown; its first save is due at once exactly
/// when the file moved, and with nothing typed it follows the file. Neither
/// ever makes a conflict copy here.
#[test]
fn an_outside_write_between_the_read_and_the_open_reaches_the_session() {
    let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = |n: usize| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % n as u64) as usize
    };
    for round in 0..60 {
        let root = TestRoot::new();
        let store = store(&root);
        let sections = [3, 700][next(2)];
        let mut body: String = (0..sections)
            .map(|i| format!("## Section {i}\n\nBody {i} with words.\n\n"))
            .collect();
        if next(3) == 0 {
            // A definition after the cut declines the first screens.
            body = body.replace("words", "a [ref][r]") + "[r]: https://x.test\n";
        }
        plant_note(&root, "n", &body);
        let read = store.read_for_editor("n");
        let shown = next(4) != 0 && store.quick_open_read(&read).is_some();
        let outside = match next(4) {
            0 => body.clone(),
            1 => format!("# PEER\n\n{body}"),
            2 => format!("{body}PEER tail\n"),
            _ => body.replacen("Body 1 ", "Body PEER ", 1),
        };
        plant_note(&root, "n", &outside);
        let mut session = store.open_editor_read(&read).unwrap();
        let moved = outside != body;
        let at = format!("round {round}, shown {shown}, moved {moved}");
        if shown {
            assert_eq!(session.source_text(), body, "{at}");
            assert_eq!(session.save_delay().is_some(), moved, "{at}");
            session.save_if_due().unwrap();
            assert_eq!(session.source_text(), outside, "{at}");
        } else {
            assert_eq!(session.source_text(), outside, "{at}");
            assert_eq!(session.save_delay(), None, "{at}");
            session
                .replace(session.revision(), range(0, 0), "typed ")
                .unwrap();
            session.checkpoint().unwrap();
            assert!(
                store
                    .read("n")
                    .unwrap()
                    .ends_with(&outside[outside.len() - 20..]),
                "{at}"
            );
        }
        session.close().unwrap();
        let notes = fs::read_dir(&root.0).unwrap().count();
        assert_eq!(notes, 1, "{at}: a conflict copy");
    }
}
