//! Issue #359: text typed where a lone marker would read as other syntax (a
//! `#` at a line start reads as an empty heading) lands escaped. Once the
//! next input makes the text plain, the escapes the engine wrote are dropped
//! and the note saves the characters as typed. Escapes already in the note
//! stay.
use futo_notes_editor::{
    DisplayOffset, DisplayRange, EditorSession, HistoryClock, InlineFormat, InputAction,
    ParagraphKey,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

struct Clock(Arc<AtomicU64>);
impl HistoryClock for Clock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::SeqCst))
    }
}

fn range(a: usize, z: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(z),
    }
}

/// `note` opened with the caret at display offset `caret`, or at the end.
fn open_at(note: &str, caret: Option<usize>) -> (EditorSession, Arc<AtomicU64>) {
    let clock = Arc::new(AtomicU64::new(0));
    let mut s = EditorSession::open_with_clock(note, Arc::new(Clock(clock.clone())));
    let at = caret.unwrap_or(s.display_text().len());
    s.select(s.revision(), range(at, at)).unwrap();
    (s, clock)
}

fn input(s: &mut EditorSession, text: &str, action: InputAction) {
    s.replace_action(s.revision(), s.selection(), text, action, &mut |_| Ok(()))
        .unwrap();
}

fn type_chars(s: &mut EditorSession, text: &str) {
    for ch in text.chars() {
        input(s, &ch.to_string(), InputAction::Typing);
    }
}

fn key(s: &mut EditorSession, key: ParagraphKey) {
    s.paragraph_key(s.revision(), s.selection(), key, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
}

fn undo(s: &mut EditorSession) {
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
}

fn redo(s: &mut EditorSession) {
    s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
}

fn last_line(source: &str) -> &str {
    source.rsplit('\n').next().unwrap()
}

fn escaped(text: &str) -> bool {
    text.contains("&#") || text.contains('\\')
}

const SHAPES: &[(&str, &str, Option<usize>)] = &[
    ("empty note", "", None),
    ("after a paragraph", "abc\n", None),
    ("list item", "- ", None),
    ("ordered item", "1. ", None),
    ("quote", "> ", None),
    ("quoted item", "> - ", None),
    ("heading", "# ", None),
];

#[test]
fn words_typed_where_a_marker_would_read_as_syntax_save_as_typed() {
    let words = [
        "#todo",
        "#日本",
        "#é",
        "#😀",
        "##x",
        "######x",
        "-5 degrees",
        "-x",
        "--x",
        "*nix",
        "+1",
        "1.5kg",
        "1)x",
        "=x",
        "= x",
        "|x",
        "~x",
        "`x",
        "_x",
    ];
    let mut bad = Vec::new();
    for (shape, note, caret) in SHAPES {
        for word in words {
            let (mut s, _) = open_at(note, *caret);
            type_chars(&mut s, word);
            let source = s.source_text();
            if escaped(last_line(&source)) || !s.display_text().ends_with(word) {
                bad.push(format!("{word:?} in {shape}: {source:?}"));
            }
        }
        // A quote marker still reads as a quote unescaped.
        let (mut s, _) = open_at(note, *caret);
        type_chars(&mut s, ">x");
        assert!(s.display_text().ends_with(">x"), "{shape}");
    }
    assert!(bad.is_empty(), "escapes survive:\n{}", bad.join("\n"));
}

#[test]
fn a_typed_hash_then_space_is_a_heading_without_entities() {
    for (note, caret) in [("", None), ("abc\n", None), ("abc\ndef", Some(4))] {
        let (mut s, _) = open_at(note, caret);
        type_chars(&mut s, "# x");
        assert!(!escaped(&s.source_text()), "{:?}", s.source_text());
    }
}

#[test]
fn a_typed_tag_is_found_as_a_tag() {
    for (note, typed) in [("", "#todo"), ("", "# Title #tag"), ("abc\n", "#x y")] {
        let (mut s, _) = open_at(note, None);
        type_chars(&mut s, typed);
        assert!(!escaped(&s.source_text()), "{:?}", s.source_text());
        assert_eq!(s.tags().len(), 1, "{typed:?}: {:?}", s.tags());
    }
}

#[test]
fn table_delimiters_typed_under_a_header_make_a_table() {
    let (mut s, _) = open_at("a | b\n", None);
    type_chars(&mut s, "-|-");
    assert_eq!(s.source_text(), "a | b\n-|-");
    let end = s.display_text().len();
    let tables = s.inspect_tables(s.revision(), range(0, end)).unwrap();
    assert_eq!(tables.len(), 1);
}

#[test]
fn a_word_typed_at_a_line_start_is_one_undo_action() {
    for word in ["#todo", "-5", "*nix", "##x", "#日本"] {
        let (mut s, _) = open_at("abc\n", None);
        type_chars(&mut s, word);
        undo(&mut s);
        assert_eq!(s.source_text(), "abc\n", "{word:?}");
        redo(&mut s);
        assert_eq!(s.source_text(), format!("abc\n{word}"), "{word:?}");
    }
}

#[test]
fn undo_or_backspace_back_to_a_typed_hash_then_typing_on_saves_as_typed() {
    // A pause splits the word into two undo actions; the first is the escaped `#`.
    let (mut s, clock) = open_at("abc\n", None);
    type_chars(&mut s, "#");
    clock.fetch_add(900, Ordering::SeqCst);
    type_chars(&mut s, "todo");
    undo(&mut s);
    assert_eq!(s.display_text(), "abc\n#");
    type_chars(&mut s, "x");
    assert_eq!(s.source_text(), "abc\n#x");
    // Redo of the lone `#`, then typing on.
    let (mut s, _) = open_at("abc\n", None);
    type_chars(&mut s, "#");
    undo(&mut s);
    redo(&mut s);
    type_chars(&mut s, "todo");
    assert_eq!(s.source_text(), "abc\n#todo");
    // Backspace back to the `#`.
    let (mut s, _) = open_at("abc\n", None);
    type_chars(&mut s, "#t");
    key(&mut s, ParagraphKey::Backspace);
    type_chars(&mut s, "b");
    assert_eq!(s.source_text(), "abc\n#b");
    // Backspace over the lone `#`, then a new tag.
    for (note, expected) in [
        ("", "#x"),
        ("abc\n", "abc\n#x"),
        ("abc\r\n", "abc\r\n#x"),
        ("- a\n", "- #xa\n"),
    ] {
        let caret = if note == "- a\n" { Some(0) } else { None };
        let (mut s, _) = open_at(note, caret);
        type_chars(&mut s, "#");
        key(&mut s, ParagraphKey::Backspace);
        type_chars(&mut s, "#x");
        assert_eq!(s.source_text(), expected, "{note:?}");
    }
}

#[test]
fn host_inputs_after_a_typed_hash_save_as_typed() {
    // IME and Android keyboards commit a composed word.
    let (mut s, _) = open_at("abc\n", None);
    type_chars(&mut s, "#");
    s.compose(s.revision(), s.selection(), "to").unwrap();
    s.commit_composition(s.revision(), None, &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "abc\n#to");
    // QuickType, swipe typing and emoji arrive as one isolated insert.
    for text in ["todo", "todo ", "😀", "日本"] {
        let (mut s, _) = open_at("abc\n", None);
        type_chars(&mut s, "#");
        input(&mut s, text, InputAction::Isolated);
        assert_eq!(s.source_text(), format!("abc\n#{text}"));
    }
}

#[test]
fn a_format_carried_at_the_caret_survives_the_escape_drop() {
    for (format, expected) in [
        (InlineFormat::Bold, "#**t**"),
        (InlineFormat::Italic, "#*t*"),
        (InlineFormat::Strike, "#~~t~~"),
        (InlineFormat::Code, "#`t`"),
    ] {
        let (mut s, _) = open_at("", None);
        type_chars(&mut s, "#");
        s.toggle_format(s.revision(), format, &mut |_| Ok(()))
            .unwrap();
        type_chars(&mut s, "t");
        assert_eq!(s.source_text(), expected, "{format:?}");
        assert_eq!(s.display_text(), "#t");
    }
}

/// An escape already in the note is the user's, not the engine's.
#[test]
fn escapes_already_in_the_note_are_left_alone() {
    for note in ["&#45;x", "abc\n&#35;", "&#49;.", "\\#"] {
        let (mut s, _) = open_at(note, None);
        type_chars(&mut s, "y");
        assert!(
            s.source_text().starts_with(note),
            "{note:?}: {:?}",
            s.source_text()
        );
    }
    // Deleted and restored by Undo, it is still the note's own.
    let (mut s, _) = open_at("abc\n&#35;", None);
    key(&mut s, ParagraphKey::Backspace);
    undo(&mut s);
    type_chars(&mut s, "y");
    assert_eq!(s.source_text(), "abc\n&#35;y");
}
