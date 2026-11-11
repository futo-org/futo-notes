//! A word completion under a toggled format (#360) must not respell anything the user did not
//! touch: lines of a span crossing a line break, or the text before a word that follows
//! punctuation. Such words are planned as before the whole-word plan.
use futo_notes_editor::*;
use InlineFormat::{Bold, Italic, Strike};

fn r(a: usize, b: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(b),
    }
}

/// Open `note`, put the caret after the first display occurrence of `needle`, toggle `format`
/// there, then complete the last `back` bytes before the caret to `text` as a text service does.
fn complete(note: &str, needle: &str, format: InlineFormat, back: usize, text: &str) -> String {
    let mut s = EditorSession::open(note);
    let d = s.display_text();
    let caret = d.find(needle).unwrap() + needle.len();
    s.select(s.revision(), r(caret, caret)).unwrap();
    s.toggle_format(s.revision(), format, &mut |_| Ok(()))
        .unwrap();
    s.replace_os(s.revision(), r(caret - back, caret), text, &[], &mut |_| {
        Ok(())
    })
    .unwrap()
    .expect("accepted");
    assert_eq!(
        s.display_text(),
        format!("{}{}{}", &d[..caret - back], text, &d[caret..])
    );
    s.source_text()
}

/// A span opened on an earlier line of the paragraph: the completion rewrites that line.
#[test]
fn a_completion_keeps_the_earlier_line_of_a_span_that_crosses_a_line_break() {
    for (note, first_line) in [
        ("**one\nhel**", "**one"),
        ("**a\\\nhel**", "**a\\"),
        ("**one  \nhel**", "**one  "),
        ("> **one\n> hel**", "> **one"),
        ("- **one\n  hel**", "- **one"),
    ] {
        let source = complete(note, "hel", Bold, 3, "hello");
        assert_eq!(
            source.split('\n').next().unwrap(),
            first_line,
            "{note:?} -> {source:?}: untouched first line rewritten"
        );
    }
}

/// A word after punctuation: the markers written at its start make the engine escape
/// characters the user did not touch, on this line or an earlier one.
#[test]
fn a_completion_after_punctuation_escapes_nothing_the_user_did_not_touch() {
    for (note, kept) in [
        ("_a\nsnake_hel", "_a\nsnake_"),
        ("_a snake_hel", "_a snake_"),
    ] {
        let source = complete(note, "snake_hel", Italic, 3, "hello");
        assert!(source.starts_with(kept), "{note:?} -> {source:?}");
    }
}

/// The word's own first letter is saved as an HTML entity.
#[test]
fn a_completion_after_punctuation_writes_no_entity() {
    for (note, needle, text) in [
        ("**a.hel**", "a.hel", "hello"),
        ("**self-hel**", "self-hel", "help"),
        ("**R&hel**", "R&hel", "hello"),
        ("**a😀hel**", "a😀hel", "hello"),
    ] {
        let source = complete(note, needle, Bold, 3, text);
        assert!(!source.contains("&#"), "{note:?} -> {source:?}");
    }
}

/// Strike off inside a span: the word leaves it and the space beside it keeps main's spelling.
#[test]
fn strike_off_inside_a_span_splits_it_around_the_whole_word() {
    let source = complete("~~foo hel bar~~", "hel", Strike, 3, "hello");
    assert_eq!(source, "~~foo~~ hello ~~bar~~");
}

/// A word after a space in a table cell takes the toggled format whole.
#[test]
fn a_table_cell_completion_after_a_space_takes_the_format_whole() {
    let source = complete("| h |\n|---|\n| a **hel** |", "hel", Bold, 3, "hello");
    assert_eq!(source, "| h |\n|---|\n| a hello |");
}

/// Undo restores the carried formats but not the toggle record, so completing again splits the
/// word as it always did. Pinned as the current behaviour.
#[test]
fn completing_again_after_undo_splits_the_word_as_before() {
    let mut s = EditorSession::open("**hel**");
    s.select(s.revision(), r(3, 3)).unwrap();
    s.toggle_format(s.revision(), Bold, &mut |_| Ok(()))
        .unwrap();
    s.replace_os(s.revision(), r(0, 3), "hello", &[], &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(s.source_text(), "hello");
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    s.replace_os(s.revision(), r(0, 3), "hello", &[], &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(s.source_text(), "**hel**lo");
}
