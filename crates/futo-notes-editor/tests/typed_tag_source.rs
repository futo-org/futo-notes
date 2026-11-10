//! Issue #359: typing or pasting `#tag` at a line start must save the
//! characters as typed, never as a numeric character reference.
use futo_notes_editor::{
    DisplayOffset, DisplayRange, EditorSession, HistoryClock, InputAction, ParagraphKey, Revision,
};
use std::sync::Arc;

struct Clock;
impl HistoryClock for Clock {
    fn now(&self) -> std::time::Duration {
        std::time::Duration::ZERO
    }
}

fn range(a: usize, z: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(z),
    }
}

fn open_at(note: &str, caret: usize) -> EditorSession {
    let mut s = EditorSession::open_with_clock(note, Arc::new(Clock));
    s.select(s.revision(), range(caret, caret)).unwrap();
    s
}

/// Types one character at a time like a keyboard; returns the source after
/// every keystroke.
fn type_chars(s: &mut EditorSession, text: &str) -> Vec<String> {
    text.chars()
        .map(|ch| {
            s.replace_action(
                s.revision(),
                s.selection(),
                &ch.to_string(),
                InputAction::Typing,
                &mut |_| Ok(()),
            )
            .unwrap();
            s.source_text()
        })
        .collect()
}

fn assert_no_entity(label: &str, source: &str) {
    assert!(
        !source.contains("&#"),
        "{label}: numeric entity in saved source {source:?}"
    );
}

fn typed_tag(label: &str, note: &str, caret: usize, expected: &str) {
    let mut s = open_at(note, caret);
    let states = type_chars(&mut s, "#todo");
    eprintln!("{label}: per-keystroke sources {states:?}");
    assert_eq!(s.source_text(), expected, "{label}");
    assert_no_entity(label, &s.source_text());
}

#[test]
fn typed_tag_in_an_empty_note_keeps_its_hash() {
    typed_tag("empty", "", 0, "#todo");
}
#[test]
fn typed_tag_after_a_paragraph_and_newline_keeps_its_hash() {
    typed_tag("after abc\\n", "abc\n", 4, "abc\n#todo");
}
#[test]
fn typed_tag_at_the_start_of_a_middle_line_keeps_its_hash() {
    typed_tag("middle", "abc\ndef", 4, "abc\n#tododef");
}
#[test]
fn typed_tag_after_enter_keeps_its_hash() {
    let mut s = open_at("abc", 3);
    s.paragraph_key(s.revision(), s.selection(), ParagraphKey::Enter, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    let states = type_chars(&mut s, "#todo");
    eprintln!("after Enter: {states:?}");
    assert_eq!(s.source_text(), "abc\n#todo");
    assert_no_entity("after Enter", &s.source_text());
}
#[test]
fn typed_hash_then_space_is_a_heading_without_entities() {
    let mut s = open_at("abc\n", 4);
    let states = type_chars(&mut s, "# ");
    eprintln!("hash space: {states:?}");
    assert_eq!(s.source_text(), "abc\n# ");
    assert_no_entity("hash space", &s.source_text());
}
#[test]
fn undo_and_redo_of_a_typed_hash_leave_no_entity() {
    let mut s = open_at("abc\n", 4);
    let typed = type_chars(&mut s, "#");
    eprintln!("lone hash: {typed:?}");
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), "abc\n");
    s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    eprintln!("after redo: {:?}", s.source_text());
    // finish the tag after the redo
    let states = type_chars(&mut s, "todo");
    eprintln!("finish after redo: {states:?}");
    assert_eq!(s.source_text(), "abc\n#todo");
    assert_no_entity("redo then finish", &s.source_text());
}
#[test]
fn pasted_tag_at_a_line_start_keeps_its_hash() {
    for (label, note, caret, expected) in [
        ("paste empty", "", 0, "#todo"),
        ("paste after abc\\n", "abc\n", 4, "abc\n#todo"),
        ("paste middle", "abc\ndef", 4, "abc\n#tododef"),
    ] {
        let mut s = open_at(note, caret);
        s.paste_markdown(s.revision(), range(caret, caret), "#todo", &mut |_| Ok(()))
            .unwrap();
        eprintln!("{label}: {:?}", s.source_text());
        assert_eq!(s.source_text(), expected, "{label}");
        assert_no_entity(label, &s.source_text());
        let _ = Revision(0);
    }
}
