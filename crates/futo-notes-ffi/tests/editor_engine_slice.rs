//! The rebuilt core end to end through the native surface (the `engine` feature): open a
//! note, type a list item, draw it, save.
mod support;
use futo_notes_ffi::*;
use support::{path_string, TempTree};

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn rows(session: &NativeEditorSession, rev: u64) -> Vec<(u64, EditorListMarker, String)> {
    let end = session.display_text().unwrap().len() as u64;
    session
        .style_plan(rev, EditorByteRange { start: 0, end })
        .unwrap()
        .into_iter()
        .filter_map(|span| match span {
            EditorStyleSpan::ListRow {
                indent,
                marker,
                text,
                ..
            } => Some((indent, marker, text)),
            _ => None,
        })
        .collect()
}

#[test]
fn a_typed_list_item_draws_its_marker_as_typed_and_saves_exactly_what_was_typed() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let body = "1) one\n   - three spaces\n - one space\n";
    store
        .create_note("n".into(), "".into(), body.into())
        .unwrap();
    let session = store.open_editor("n".into()).unwrap();
    assert_eq!(
        session.display_text().unwrap(),
        "one\nthree spaces\none space\n"
    );
    let mut rev = session.revision().unwrap();
    assert_eq!(
        rows(&session, rev),
        [
            (0, EditorListMarker::Ordered, "1)".to_owned()),
            (3, EditorListMarker::Bullet, "-".to_owned()),
            (1, EditorListMarker::Bullet, "-".to_owned()),
        ]
    );
    // Type `3) third` on the empty last line, one key at a time, as a keyboard does.
    let mut at = session.display_text().unwrap().encode_utf16().count() as u64;
    for ch in "3) third".chars() {
        let change = session
            .replace_utf16_action(
                rev,
                EditorUtf16Range { start: at, end: at },
                utf16(&ch.to_string()),
                EditorInputAction::Typing,
            )
            .unwrap();
        rev = change.revision;
        at = session
            .display_to_utf16(rev, change.selection)
            .unwrap()
            .start;
    }
    assert_eq!(
        session.display_text().unwrap(),
        "one\nthree spaces\none space\nthird"
    );
    assert_eq!(
        rows(&session, rev).last(),
        Some(&(0, EditorListMarker::Ordered, "3)".to_owned()))
    );
    // Enter continues the numbered list with the next number; Enter on that
    // empty item takes its marker off, leaving a plain line.
    let change = session
        .paragraph_key_utf16(
            rev,
            EditorUtf16Range { start: at, end: at },
            EditorParagraphKey::Enter,
        )
        .unwrap()
        .unwrap();
    rev = change.revision;
    at = session
        .display_to_utf16(rev, change.selection)
        .unwrap()
        .start;
    assert_eq!(
        rows(&session, rev).last(),
        Some(&(0, EditorListMarker::Ordered, "4)".to_owned()))
    );
    let change = session
        .paragraph_key_utf16(
            rev,
            EditorUtf16Range { start: at, end: at },
            EditorParagraphKey::Enter,
        )
        .unwrap()
        .unwrap();
    rev = change.revision;
    at = session
        .display_to_utf16(rev, change.selection)
        .unwrap()
        .start;
    // An indented plain line draws at its own indent.
    for ch in "  note".chars() {
        let change = session
            .replace_utf16_action(
                rev,
                EditorUtf16Range { start: at, end: at },
                utf16(&ch.to_string()),
                EditorInputAction::Typing,
            )
            .unwrap();
        rev = change.revision;
        at = session
            .display_to_utf16(rev, change.selection)
            .unwrap()
            .start;
    }
    assert_eq!(
        rows(&session, rev).last(),
        Some(&(2, EditorListMarker::Plain, String::new()))
    );
    let typed = "1) one\n   - three spaces\n - one space\n3) third\n  note";
    assert_eq!(session.source_text().unwrap(), typed);
    session.checkpoint().unwrap();
    // Saving ends a nonempty note with a line ending (the store's rule).
    let file = std::fs::read_to_string(tree.path("vault").join("n.md")).unwrap();
    assert_eq!(file, format!("{typed}\n"));
    // Undo walks back to the opened bytes.
    while let Some(change) = session.undo(rev).unwrap() {
        rev = change.revision;
    }
    assert_eq!(session.source_text().unwrap(), body);
    session.detach().unwrap();
    assert_eq!(
        std::fs::read_to_string(tree.path("vault").join("n.md")).unwrap(),
        body
    );
}
