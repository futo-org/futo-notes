//! Cut, paste and typing in place, through the public session: what a cut
//! leaves, and that pasting or typing there puts the bytes back.
use super::{paste, range, EditorSession, InlineFormat, ParagraphKey, Revision, SourceEdit};

#[test]
fn a_paste_is_in_code_where_it_lands_not_where_the_selection_is() {
    // The selection is at the start; the paste lands at the span's text end,
    // where a caret placed there stands inside the span.
    let mut s = EditorSession::open("a `bc` z");
    s.select(Revision(0), range(0, 0)).unwrap();
    s.paste_markdown(s.revision(), range(4, 4), "`xy`", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "a `bcxy` z");
}

#[test]
fn text_joining_a_bare_quote_marker_stays_a_quote_line() {
    let s = paste("> ad", range(1, 1), "b\n>", Some(3));
    assert_eq!(s.source_text(), "> ab\n> d");
}

/// Select `a..b`, cut it, and paste the copy at the caret the cut left.
fn cut_then_paste(source: &str, a: usize, b: usize) -> String {
    let mut s = EditorSession::open(source);
    let mut accept = |_: &SourceEdit| Ok(());
    s.select(s.revision(), range(a, b)).unwrap();
    let (copied, _) = s
        .cut_markdown(s.revision(), range(a, b), &mut accept)
        .unwrap();
    let caret = s.selection();
    s.paste_markdown(s.revision(), caret, &copied, &mut accept)
        .unwrap();
    s.source_text()
}

#[test]
fn cut_then_paste_in_place_gives_the_same_bytes() {
    // (source, display range cut)
    for (source, (a, b)) in [
        // A whole bold word: the marks the cut left carried are not written
        // around the copy's own again.
        ("a **bold** c\n", (2, 6)),
        // A range across two quoted lines is not quoted twice.
        ("> ab\n> cd\n", (1, 4)),
        // Part of an inline code span stays code.
        ("`gamma`\n", (1, 2)),
        // A line's first word: the space after it is not typed past.
        ("ab cd\n", (0, 2)),
        ("  ab cd\n", (0, 2)),
    ] {
        assert_eq!(cut_then_paste(source, a, b), source, "{source:?} {a}..{b}");
    }
}

#[test]
fn typing_after_deleting_a_lines_first_word_keeps_the_space() {
    // The space after the word reads as hidden indent once the word is gone;
    // what is typed or pasted next still goes before it, in the formats the
    // deleted word carried.
    for (source, expected) in [
        ("ab cd\n", "xy cd\n"),
        ("  ab cd\n", "  xy cd\n"),
        ("> ab cd\n", "> xy cd\n"),
        ("**ab** cd\n", "**xy** cd\n"),
        ("> *ab* cd\n", "> *xy* cd\n"),
    ] {
        for deleted in ["replace", "backspace", "cut"] {
            for pasted in [false, true] {
                let mut s = EditorSession::open(source);
                let mut accept = |_: &SourceEdit| Ok(());
                let word = s.display_text().find("ab").unwrap();
                let at = range(word, word + 2);
                match deleted {
                    "replace" => {
                        s.replace(s.revision(), at, "", &mut accept).unwrap();
                    }
                    "backspace" => {
                        s.paragraph_key(s.revision(), at, ParagraphKey::Backspace, &mut accept)
                            .unwrap();
                    }
                    _ => {
                        s.cut_markdown(s.revision(), at, &mut accept).unwrap();
                    }
                }
                let caret = s.selection();
                if pasted {
                    s.paste_markdown(s.revision(), caret, "xy", &mut accept)
                        .unwrap();
                } else {
                    s.replace(s.revision(), caret, "xy", &mut accept).unwrap();
                }
                let how = if pasted { "pasted" } else { "typed" };
                assert_eq!(
                    s.source_text(),
                    expected,
                    "{source:?} {how} after {deleted}"
                );
            }
        }
    }
}

#[test]
fn a_format_toggled_on_after_deleting_a_lines_first_word_applies_before_its_space() {
    let mut s = EditorSession::open("ab cd\n");
    let mut accept = |_: &SourceEdit| Ok(());
    s.replace(s.revision(), range(0, 2), "", &mut accept)
        .unwrap();
    s.toggle_format(s.revision(), InlineFormat::Bold, &mut accept)
        .unwrap();
    let caret = s.selection();
    s.replace(s.revision(), caret, "x", &mut accept).unwrap();
    assert_eq!(s.source_text(), "**x** cd\n");
}
