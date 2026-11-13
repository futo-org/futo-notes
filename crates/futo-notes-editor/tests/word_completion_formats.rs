//! A keyboard's word completion reaches the engine as one text-service replacement
//! (`replace_os_utf16`) of the typed word. It must not write markers around part of the word
//! (#360: Bold turned off after `hel` saved `**hel**lo`).
mod common;
use common::ReferenceView;
use futo_notes_editor::*;
use InlineFormat::{Bold, Code, Italic, Strike};

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

#[allow(clippy::too_many_arguments)]
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
        "[a hel](u)",
        5,
        &[Toggle(Bold)],
        3,
        "hello",
        "[a **hello**](u)",
        "a hello",
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
        "cyrillic",
        "",
        0,
        &[Toggle(Bold), Type("при"), Toggle(Bold)],
        3,
        "привет ",
        "привет ",
        "привет ",
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

#[test]
fn a_completion_that_changes_earlier_letters_takes_the_carried_format_whole() {
    for (typed, completion) in [("joh", "John"), ("hel", "Hello")] {
        check(
            &format!("{typed} to {completion}"),
            "",
            0,
            &[Toggle(Bold), Type(typed), Toggle(Bold)],
            3,
            completion,
            completion,
            completion,
        );
    }
}

/// Where the whole word cannot take the carried formats without touching text the user did not
/// toggle, the completion is planned as before: only its new letters take them.
#[test]
fn a_word_with_mixed_formats_links_or_spaces_keeps_what_the_toggle_did_not_touch() {
    for (source, format, word, completion, expected) in [
        // The word straddles a link's edge.
        ("see[hel](u)", Bold, 6, "seehello", "see[hel**lo**](u)"),
        ("[he](u)l", Bold, 3, "hello", "[he](u)l**lo**"),
        ("[hel](u)", Bold, 3, "hello", "[hel**lo**](u)"),
        // Part of the word has formats the caret does not.
        ("*he*l", Bold, 3, "hello", "*he*l**lo**"),
        ("pre**hel**", Italic, 6, "prehello", "pre**hel*lo***"),
        ("`he`l", Bold, 3, "hello", "`he`l**lo**"),
        // The range holds more than one word.
        (
            "foo **bar** hel",
            Bold,
            11,
            "foo bar hello",
            "foo **bar** hel**lo**",
        ),
        ("**one** hel", Italic, 7, "one hello", "**one** hel*lo*"),
    ] {
        let end = EditorSession::open(source).display_text().len();
        let (session, _, _) = complete(source, end, &[Toggle(format)], word, completion);
        assert_eq!(session.source_text(), expected, "{source:?}");
    }
}

#[test]
fn a_toggle_adds_to_the_word_s_own_formats() {
    check(
        "italic on a bold word",
        "**hel**",
        3,
        &[Toggle(Italic)],
        3,
        "hello",
        "***hello***",
        "hello",
    );
    // The space before the word takes Strike as typing the word under it does.
    check(
        "strike after a struck word",
        "~~x~~ hel",
        5,
        &[Toggle(Strike)],
        3,
        "hello",
        "~~x hello~~",
        "x hello",
    );
}

/// A caret after a bold word that reads the formats after it is not bold; turning Italic on there
/// must not take Bold off the word.
#[test]
fn a_caret_that_reads_the_formats_after_it_keeps_the_word_s_own() {
    let mut session = EditorSession::open("**hel**");
    let caret = DisplayRange {
        start: DisplayOffset(3),
        end: DisplayOffset(3),
    };
    session
        .select_with_affinity(session.revision(), caret, Affinity::Forward)
        .unwrap();
    assert!(session.active_formats().is_empty());
    session
        .toggle_format(session.revision(), Italic, &mut |_| Ok(()))
        .unwrap();
    let word = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(3),
    };
    session
        .replace_os(session.revision(), word, "hello", &[], &mut |_| Ok(()))
        .unwrap();
    assert_eq!(session.source_text(), "**hel***lo*");
}

/// The check reads only the word's own row: a completion on a 1 MB note parses no more source
/// than one on a short note.
#[test]
fn a_completion_under_a_toggled_format_reads_only_its_paragraph() {
    let mut note = String::new();
    while note.len() < 1_000_000 {
        note.push_str("Some **bold** text and *italic* words with a [link](https://x.y) here.\n\n");
    }
    let end = EditorSession::open(&note).display_text().len();
    let mut session = EditorSession::open(&note);
    let caret = DisplayRange {
        start: DisplayOffset(end),
        end: DisplayOffset(end),
    };
    session.select(session.revision(), caret).unwrap();
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
        start: DisplayOffset(end),
        end: DisplayOffset(end + 3),
    };
    let started = std::time::Instant::now();
    let change = session
        .replace_os(session.revision(), word, "hello", &[], &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    let elapsed = started.elapsed();
    assert!(session.source_text().ends_with("\n\nhello"));
    assert!(change.work.parsed_source_bytes < 4_096, "{:?}", change.work);
    assert!(
        change.work.materialized_source_bytes < 4_096,
        "{:?}",
        change.work
    );
    assert!(elapsed.as_millis() < 100, "took {elapsed:?}");
}
