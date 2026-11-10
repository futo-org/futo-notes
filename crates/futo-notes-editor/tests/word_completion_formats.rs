//! A keyboard's word completion reaches the engine as one text-service replacement
//! (`replace_os_utf16`) of the typed word. It must not write markers around part of the word
//! (#360: Bold turned off after `hel` saved `**hel**lo`).
mod common;
use common::ReferenceView;
use futo_notes_editor::*;
use InlineFormat::{Bold, Code, Italic};

enum Step {
    Type(&'static str),
    Toggle(InlineFormat),
}
use Step::{Toggle, Type};

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn utf16_range(start: usize, end: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(start),
        end: DisplayUtf16Offset(end),
    }
}

/// Open `source`, put the caret at `caret` (UTF-16 display offset), run `steps`, then deliver
/// `completion` over the last `word` UTF-16 units before the caret, as UIKit does. Returns the
/// session, its mirrored display and the source before the completion.
fn complete(
    source: &str,
    caret: usize,
    steps: &[Step],
    word: usize,
    completion: &str,
) -> (EditorSession, ReferenceView, String) {
    let mut session = EditorSession::open(source);
    let mut view = ReferenceView::new(&session.display_text());
    session
        .select_utf16(session.revision(), utf16_range(caret, caret))
        .unwrap();
    for step in steps {
        let rev = session.revision();
        match step {
            Toggle(format) => {
                if let Some(change) = session
                    .toggle_format(rev, *format, &mut |_| Ok(()))
                    .unwrap()
                {
                    view.apply(change);
                }
            }
            Type(text) => {
                let at = session.display_to_utf16(rev, session.selection()).unwrap();
                view.apply(
                    session
                        .replace_utf16_action(
                            rev,
                            at,
                            &units(text),
                            InputAction::Typing,
                            &mut |_| Ok(()),
                        )
                        .unwrap(),
                );
            }
        }
    }
    let before = session.source_text();
    let end = session
        .display_to_utf16(session.revision(), session.selection())
        .unwrap()
        .end
        .0;
    let change = session
        .replace_os_utf16(
            session.revision(),
            utf16_range(end - word, end),
            &units(completion),
            &[],
            &mut |_| Ok(()),
        )
        .unwrap()
        .expect("the completion is accepted");
    view.apply(change);
    (session, view, before)
}

fn check(
    label: &str,
    source: &str,
    caret: usize,
    steps: &[Step],
    word: usize,
    completion: &str,
    expected_source: &str,
    expected_display: &str,
) {
    let (mut session, mut view, before) = complete(source, caret, steps, word, completion);
    assert_eq!(session.source_text(), expected_source, "{label}: source");
    assert_eq!(session.display_text(), expected_display, "{label}: display");
    assert_eq!(view.text, expected_display, "{label}: mirrored display");
    // One undo step puts back what the text service replaced.
    let undone = session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    view.apply(undone);
    assert_eq!(session.source_text(), before, "{label}: undo source");
    assert_eq!(view.text, session.display_text(), "{label}: undo display");
}

#[test]
fn turning_a_format_off_after_typing_a_word_formats_the_whole_completed_word() {
    for (format, mark) in [(Bold, "**"), (Italic, "*"), (Code, "`")] {
        for completion in ["hello", "hello "] {
            check(
                &format!("{format:?} off, {completion:?}"),
                "",
                0,
                &[Toggle(format), Type("hel"), Toggle(format)],
                3,
                completion,
                completion,
                completion,
            );
            // Still on: the completed word is wholly inside the markers.
            let (session, _, _) = complete("", 0, &[Toggle(format), Type("hel")], 3, "hello");
            assert_eq!(session.source_text(), format!("{mark}hello{mark}"));
        }
    }
}

#[test]
fn turning_a_format_on_after_typing_a_word_formats_the_whole_completed_word() {
    check(
        "bold on",
        "",
        0,
        &[Type("hel"), Toggle(Bold)],
        3,
        "hello",
        "**hello**",
        "hello",
    );
    check(
        "bold on mid line",
        "word ",
        5,
        &[Type("hel"), Toggle(Bold)],
        3,
        "hello ",
        "word **hello** ",
        "word hello ",
    );
}

#[test]
fn only_the_carried_difference_changes_when_formats_stack() {
    check(
        "bold and italic, bold off",
        "",
        0,
        &[Toggle(Bold), Toggle(Italic), Type("hel"), Toggle(Bold)],
        3,
        "hello",
        "*hello*",
        "hello",
    );
}

#[test]
fn neighbouring_text_keeps_its_source_bytes() {
    check(
        "after a bold word, off",
        "**ab** ",
        3,
        &[Type("hel")],
        3,
        "hello",
        "**ab** hello",
        "ab hello",
    );
    check(
        "bold word, then word with bold off",
        "",
        0,
        &[Toggle(Bold), Type("ab hel"), Toggle(Bold)],
        3,
        "hello",
        "**ab** hello",
        "ab hello",
    );
    check(
        "plain word before",
        "a b ",
        4,
        &[Toggle(Bold), Type("hel"), Toggle(Bold)],
        3,
        "hello",
        "a b hello",
        "a b hello",
    );
}

#[test]
fn completion_inside_or_beside_existing_spans_keeps_them_when_nothing_is_carried() {
    for (source, caret, expected) in [
        ("**ab hel**", 6, "**ab hello**"),
        ("*hel*", 3, "*hello*"),
        ("`hel`", 3, "`hello`"),
        ("[hel](u)", 3, "[hello](u)"),
        ("**ab** hel", 6, "**ab** hello"),
        ("hel **b**", 3, "hello **b**"),
    ] {
        let (session, _, _) = complete(source, caret, &[], 3, "hello");
        assert_eq!(session.source_text(), expected, "{source:?}");
    }
}

#[test]
fn a_link_label_takes_the_carried_format_for_the_whole_word() {
    check(
        "bold on in a link",
        "[a](u)",
        1,
        &[Type("hel"), Toggle(Bold)],
        3,
        "hello",
        "[a**hello**](u)",
        "ahello",
    );
}

#[test]
fn line_starts_in_blocks() {
    for (source, expected) in [
        ("", "hello"),
        ("- ", "- hello"),
        ("# ", "# hello"),
        ("> ", "> hello"),
        ("1. ", "1. hello"),
        ("- [ ] ", "- [ ] hello"),
    ] {
        let (session, _, _) = complete(
            source,
            0,
            &[Toggle(Bold), Type("hel"), Toggle(Bold)],
            3,
            "hello",
        );
        assert_eq!(session.source_text(), expected, "{source:?}");
    }
    let (session, _, _) = complete(
        "a\r\n",
        3,
        &[Toggle(Bold), Type("hel"), Toggle(Bold)],
        3,
        "hello",
    );
    assert_eq!(session.source_text(), "a\r\nhello");
}

#[test]
fn non_ascii_words_complete_the_same_way() {
    check(
        "accent",
        "",
        0,
        &[Toggle(Bold), Type("hé"), Toggle(Bold)],
        2,
        "héllo",
        "héllo",
        "héllo",
    );
    check(
        "emoji",
        "",
        0,
        &[Toggle(Bold), Type("hi😀"), Toggle(Bold)],
        4,
        "hi😀 ",
        "hi😀 ",
        "hi😀 ",
    );
}

#[test]
fn the_carried_format_still_applies_after_the_completion() {
    let (mut session, _, _) = complete(
        "",
        0,
        &[Toggle(Bold), Type("hel"), Toggle(Bold)],
        3,
        "hello ",
    );
    assert!(session.active_formats().is_empty());
    let at = session
        .display_to_utf16(session.revision(), session.selection())
        .unwrap();
    session
        .replace_utf16_action(
            session.revision(),
            at,
            &units("x"),
            InputAction::Typing,
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(session.source_text(), "hello x");
}

#[test]
fn an_ime_commit_over_the_typed_word_takes_the_carried_format_whole() {
    let mut session = EditorSession::open("");
    for step in [Toggle(Bold), Type("hel"), Toggle(Bold)] {
        let rev = session.revision();
        match step {
            Toggle(format) => {
                session.toggle_format(rev, format, &mut |_| Ok(())).unwrap();
            }
            Type(text) => {
                let at = session.selection();
                session
                    .replace_action(rev, at, text, InputAction::Typing, &mut |_| Ok(()))
                    .unwrap();
            }
        }
    }
    let word = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(3),
    };
    session.compose(session.revision(), word, "hello").unwrap();
    session
        .commit_composition(session.revision(), None, &mut |_| Ok(()))
        .unwrap();
    assert_eq!(session.source_text(), "hello");
}
