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

/// Block kind per line: heading, quote depth, divider, code, front matter, list.
fn line_kinds(source: &str) -> Vec<String> {
    let s = EditorSession::open(source);
    let all = range(0, s.display_text().len());
    let blocks = s.project(s.revision(), all).unwrap().blocks;
    let display = s.display_text();
    std::iter::once(0)
        .chain(display.match_indices('\n').map(|(at, _)| at + 1))
        .map(|at| {
            blocks
                .iter()
                .find(|b| b.range.start.0 <= at && at <= b.range.end.0)
                .map_or("none".to_owned(), |b| {
                    format!(
                        "{} {} {} {} {} {:?}",
                        b.heading, b.quote_depth, b.divider, b.code, b.metadata, b.list
                    )
                })
        })
        .collect()
}

/// Dropping an escape never changes the block kind of a line the input did
/// not touch (a setext underline, a lazy continuation, a list or quote
/// interruption); tables are the one exception, below.
#[test]
fn untouched_lines_keep_their_block_kind_while_a_word_is_typed() {
    let shapes: &[(&str, Option<usize>)] = &[
        ("abc\n", None),
        ("abc\ndef\n", Some(4)),
        ("> a\n", None),
        ("- a\n", None),
        ("1. a\n", None),
        ("# a\n", None),
        ("> - a\n", None),
        ("a\n\nb", Some(2)),
        ("abc\n\ndef", Some(4)),
    ];
    let words = [
        "=", "==", "-", "--", "---", "-x", "1.", "1)", "1.x", "+", "+x", "*", "***", "#x", ">x",
        "~~~", "```", "|x|", "a | b",
    ];
    let mut bad = Vec::new();
    for (note, caret) in shapes {
        for word in words {
            let (mut s, _) = open_at(note, *caret);
            let at = caret.unwrap_or(note.len());
            let (head, tail) = (line_kinds(&note[..at]), line_kinds(&note[at..]));
            for (n, ch) in word.chars().enumerate() {
                input(&mut s, &ch.to_string(), InputAction::Typing);
                let kinds = line_kinds(&s.source_text());
                let before = head.len() - 1;
                let after = tail.len() - 1;
                if kinds[..before] != head[..before]
                    || kinds[kinds.len() - after..] != tail[tail.len() - after..]
                {
                    bad.push(format!(
                        "{note:?} at {at} typing {:?}: {:?}",
                        word.chars().take(n + 1).collect::<String>(),
                        s.source_text()
                    ));
                    break;
                }
            }
        }
    }
    assert!(
        bad.is_empty(),
        "untouched lines changed kind:\n{}",
        bad.join("\n")
    );
}

/// The exception: a delimiter row typed under a pipe line makes a table.
#[test]
fn a_delimiter_row_typed_under_a_pipe_line_makes_a_table() {
    for (note, typed, source) in [
        ("a | b\n", "-|-", "a | b\n-|-"),
        ("| a | b |\n", "|-|-|", "| a | b |\n|-|-|"),
        ("a | b\n", ":-|-:", "a | b\n:-|-:"),
        ("| a | b |\n", "|:-:|--:|", "| a | b |\n|:-:|--:|"),
    ] {
        let (mut s, _) = open_at(note, None);
        type_chars(&mut s, typed);
        assert_eq!(s.source_text(), source);
        let tables = s.inspect_tables(s.revision(), range(0, s.display_text().len()));
        assert_eq!(tables.unwrap().len(), 1, "{typed:?}");
    }
}

/// Text that would start a block on a later line (a fence, a setext underline,
/// leading whitespace) keeps its escape.
#[test]
fn escapes_that_still_guard_the_block_structure_stay() {
    for (note, caret, typed, source) in [
        ("\nafter\nmore", Some(0), "```x", "\\```x\nafter\nmore"),
        ("\nafter", Some(0), "~~~x", "\\~~~x\nafter"),
        ("abc\n", None, "==", "abc\n&#61;="),
        ("abc\n", None, "--", "abc\n&#45;-"),
        ("", None, " #x", "&#32;#x"),
    ] {
        let (mut s, _) = open_at(note, caret);
        type_chars(&mut s, typed);
        assert_eq!(s.source_text(), source, "{note:?} + {typed:?}");
    }
    // A second `=` arriving as one insert is no different.
    let (mut s, _) = open_at("abc\n", None);
    type_chars(&mut s, "=");
    input(&mut s, "=", InputAction::Isolated);
    assert_eq!(s.source_text(), "abc\n&#61;=");
}

/// A heading's would-be closing `#` run is written as it was typed.
#[test]
fn a_hash_run_after_heading_text_saves_as_typed() {
    let (mut s, _) = open_at("", None);
    type_chars(&mut s, "# a #x");
    assert_eq!(s.source_text(), "# a #x");
}

/// An escape in the note beside a typed run is the note's, kept through Undo.
#[test]
fn a_note_escape_beside_a_typed_run_is_kept() {
    let (mut s, _) = open_at("abc\n&#35;", None);
    type_chars(&mut s, "#x");
    assert_eq!(s.source_text(), "abc\n&#35;#x");
    let (mut s, _) = open_at("&#35;", None);
    type_chars(&mut s, "#");
    undo(&mut s);
    redo(&mut s);
    type_chars(&mut s, "x");
    assert_eq!(s.source_text(), "&#35;#x");
}

/// The host's acceptance callback may type into another session: it never
/// sees the run the first session held.
#[test]
fn a_run_held_by_one_session_does_not_respell_another() {
    let (mut a, _) = open_at("", None);
    type_chars(&mut a, "#");
    assert_eq!(a.source_text(), "&#35;");
    let (mut b, _) = open_at("&#35;", Some(1));
    a.replace_action(
        a.revision(),
        a.selection(),
        "a",
        InputAction::Typing,
        &mut |_| {
            input(&mut b, "b", InputAction::Typing);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(b.source_text(), "&#35;b");
    assert_eq!(a.source_text(), "#a");
}
