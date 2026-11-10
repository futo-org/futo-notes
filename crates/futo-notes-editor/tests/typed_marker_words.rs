//! #359 sibling shapes: words that start with a Markdown-looking character,
//! typed one character at a time, must save as typed once the line no longer
//! needs an escape.
use futo_notes_editor::{
    DisplayOffset, DisplayRange, EditorSession, HistoryClock, InputAction, ParagraphKey,
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
fn type_chars(s: &mut EditorSession, text: &str) {
    for ch in text.chars() {
        s.replace_action(
            s.revision(),
            s.selection(),
            &ch.to_string(),
            InputAction::Typing,
            &mut |_| Ok(()),
        )
        .unwrap();
    }
}
fn enter(s: &mut EditorSession) {
    s.paragraph_key(
        s.revision(),
        s.selection(),
        ParagraphKey::Enter,
        &mut |_| Ok(()),
    )
    .unwrap()
    .unwrap();
}

const WORDS: &[&str] = &[
    "-5 degrees",
    "-x",
    "*nix",
    "+1",
    ">x",
    "1.5kg",
    "1)x",
    "=x",
    "|x",
    "~x",
    "`x",
    "_x",
];

/// Saved source after the last keystroke for every word at every line start.
fn run(word: &str) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    let mut s = open_at("", 0);
    type_chars(&mut s, word);
    out.push(("empty", s.source_text()));
    let mut s = open_at("abc\n", 4);
    type_chars(&mut s, word);
    out.push(("after abc\\n", s.source_text()));
    let mut s = open_at("abc", 3);
    enter(&mut s);
    type_chars(&mut s, word);
    out.push(("after Enter", s.source_text()));
    out
}

#[test]
fn words_at_a_line_start_save_as_typed_and_quote_marker_stays_escaped() {
    let mut bad = Vec::new();
    for word in WORDS {
        let shown = run(word);
        for (shape, source) in shown {
            let line = source.rsplit('\n').next().unwrap_or("").to_string();
            eprintln!("{word:?} {shape}: {source:?}");
            // `>x` reads as a quote unescaped, so its escape is still needed.
            if (line.contains("&#") && *word != ">x") || line.contains('\\') {
                bad.push(format!("{word:?} {shape}: {source:?}"));
            }
        }
    }
    assert!(bad.is_empty(), "escapes survive:\n{}", bad.join("\n"));
}

#[test]
fn tag_after_container_prefixes_saves_as_typed() {
    let mut bad = Vec::new();
    for (label, note, caret, typed, expected) in [
        ("list item", "- ", 2, "#todo", "- #todo"),
        ("task item", "- [ ] ", 6, "#todo", "- [ ] #todo"),
        ("quote", "> ", 2, "#todo", "> #todo"),
    ] {
        let mut s = open_at(note, 0);
        let end = s.display_text().len();
        let _ = caret;
        s.select(s.revision(), range(end, end)).unwrap();
        type_chars(&mut s, typed);
        eprintln!("{label}: {:?}", s.source_text());
        if s.source_text() != expected {
            bad.push(format!("{label}: {:?}", s.source_text()));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn lone_hash_then_space_at_the_caret_is_a_heading_without_entities() {
    for (note, caret) in [("", 0), ("abc\n", 4), ("abc\ndef", 4)] {
        let mut s = open_at(note, caret);
        type_chars(&mut s, "# ");
        eprintln!("{note:?}: {:?}", s.source_text());
        assert!(!s.source_text().contains("&#"), "{:?}", s.source_text());
        type_chars(&mut s, "x");
        assert!(!s.source_text().contains("&#"), "{:?}", s.source_text());
    }
}

/// An escape already in the opened note is the user's, not the engine's.
#[test]
fn escapes_already_in_the_note_are_left_alone() {
    for note in ["&#45;x", "abc\n&#35;", "&#49;."] {
        let mut s = open_at(note, 0);
        let end = s.display_text().len();
        s.select(s.revision(), range(end, end)).unwrap();
        type_chars(&mut s, "y");
        assert!(
            s.source_text().starts_with(note),
            "{note:?} became {:?}",
            s.source_text()
        );
    }
}
