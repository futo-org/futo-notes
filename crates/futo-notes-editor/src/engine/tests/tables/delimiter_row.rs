//! A delimiter row the person types, and the row once written.
use super::super::super::Engine;
use super::super::{ok, range};
use super::caret;
use crate::{CaretDirection, DisplayOffset, DisplayRange, InputAction, ParagraphKey, Revision};

/// Type `typed` one character at a time at the engine's selection.
fn type_each(engine: &mut Engine, typed: &[&str]) {
    for text in typed {
        let (revision, selection) = (engine.revision(), engine.selection());
        engine
            .replace(revision, selection, text, InputAction::Typing, &mut ok)
            .unwrap();
    }
}

/// A key at the engine's selection.
fn press(engine: &mut Engine, key: ParagraphKey) {
    let (revision, selection) = (engine.revision(), engine.selection());
    engine.key(revision, selection, key, &mut ok).unwrap();
}

/// A header, Enter, then `typed` one character at a time; each keystroke
/// reports whether the caret then writes the delimiter row.
fn typed_under_header(header: &str, typed: &[&str]) -> (Engine, Vec<bool>) {
    let mut engine = Engine::open(header);
    let end = engine.display_len();
    engine.select(Revision(0), caret(end)).unwrap();
    press(&mut engine, ParagraphKey::Enter);
    let writing = typed
        .iter()
        .map(|text| {
            type_each(&mut engine, &[text]);
            engine.writes_delimiter_row()
        })
        .collect();
    (engine, writing)
}

/// The caret is at the start of the first cell of the note's last line.
fn in_last_rows_first_cell(engine: &Engine) -> bool {
    let source = engine.source_text();
    let last = source.rfind('\n').map_or(0, |at| at + 1);
    engine.selection() == caret(engine.display_of(last + 2))
}

/// The person typing a delimiter row writes it as text, the caret on it
/// (`writes_delimiter_row`), until the keystroke that finishes it (as many
/// cells as the header, closed where the header is), or Enter or Tab, takes
/// the caret to the first body row's first cell, writing that row.
#[test]
fn typing_a_delimiter_row_writes_it_until_it_is_finished() {
    let row = ["|", "-", "-", "-", "|", "-", "-", "-", "|"];
    let (engine, writing) = typed_under_header("| a | b |", &row);
    assert_eq!(engine.source_text(), "| a | b |\n|---|---|\n|  |  |");
    assert!(in_last_rows_first_cell(&engine));
    // Plain until `|-`, written from there until the last `|` finishes it.
    let want = [false, true, true, true, true, true, true, true, false];
    assert_eq!(writing, want);

    // Enter on the row being typed leaves it the same way, as does Tab.
    for key in [ParagraphKey::Enter, ParagraphKey::Tab] {
        let (mut engine, _) = typed_under_header("| a | b |", &row[..8]);
        assert!(engine.writes_delimiter_row());
        press(&mut engine, key);
        assert_eq!(
            engine.source_text(),
            "| a | b |\n|---|---\n|  |  |",
            "{key:?}"
        );
        assert!(in_last_rows_first_cell(&engine) && !engine.writes_delimiter_row());
    }

    // A header with no closing pipe has no finishing keystroke: Enter.
    let (mut engine, writing) = typed_under_header("| a | b", &row);
    assert!(writing.iter().skip(1).all(|&writes| writes));
    press(&mut engine, ParagraphKey::Enter);
    assert_eq!(engine.source_text(), "| a | b\n|---|---|\n|  |  |");
    assert!(in_last_rows_first_cell(&engine));
}

/// Backspace on the row being typed is ordinary; right after the finishing
/// keystroke it takes that keystroke back, body row included. An arrow
/// away leaves by the unreachable rules, and the caret cannot come back.
#[test]
fn backspace_and_arrows_around_a_delimiter_row_being_typed() {
    let row = ["|", "-", "-", "-", "|"];
    let (mut engine, _) = typed_under_header("| a |", &row);
    assert_eq!(engine.source_text(), "| a |\n|---|\n|  |");
    press(&mut engine, ParagraphKey::Backspace);
    assert_eq!(engine.source_text(), "| a |\n|---");
    assert_eq!(engine.selection(), caret("| a |\n|---".len()));
    assert!(engine.writes_delimiter_row(), "typing the row again");
    press(&mut engine, ParagraphKey::Backspace);
    assert_eq!(engine.source_text(), "| a |\n|--", "an ordinary Backspace");
    assert!(engine.writes_delimiter_row());

    // Enter or Tab leaving the row is taken back the same way: the body row
    // it wrote goes, and nothing typed does.
    for key in [ParagraphKey::Enter, ParagraphKey::Tab] {
        let (mut engine, _) = typed_under_header("| a |", &row[..4]);
        press(&mut engine, key);
        assert_eq!(engine.source_text(), "| a |\n|---\n|  |", "{key:?}");
        press(&mut engine, ParagraphKey::Backspace);
        assert_eq!(engine.source_text(), "| a |\n|---", "{key:?}");
        assert_eq!(engine.selection(), caret("| a |\n|---".len()));
        assert!(
            engine.writes_delimiter_row(),
            "{key:?} typing the row again"
        );
        type_each(&mut engine, &["|"]);
        assert_eq!(engine.source_text(), "| a |\n|---|\n|  |");
    }
    // A table with a body row writes none: the move alone is taken back.
    let mut engine = Engine::open("| a |\n\n| x |");
    engine.select(Revision(0), caret("| a |\n".len())).unwrap();
    type_each(&mut engine, &["|", "-", "-"]);
    assert!(engine.writes_delimiter_row());
    press(&mut engine, ParagraphKey::Enter);
    assert_eq!(engine.selection(), caret("| a |\n|--\n| ".len()));
    press(&mut engine, ParagraphKey::Backspace);
    assert_eq!(engine.source_text(), "| a |\n|--\n| x |");
    assert_eq!(engine.selection(), caret("| a |\n|--".len()));
    assert!(engine.writes_delimiter_row());
    press(&mut engine, ParagraphKey::Backspace);
    assert_eq!(
        engine.source_text(),
        "| a |\n|-\n| x |",
        "then an ordinary one"
    );

    // An arrow away mid-row goes past the row, and no arrow comes back.
    let (mut engine, _) = typed_under_header("| a |", &row[..3]);
    let header_end = caret("| a |".len());
    engine
        .move_caret(engine.revision(), CaretDirection::Backward)
        .unwrap();
    assert_eq!(engine.selection(), header_end);
    assert!(!engine.writes_delimiter_row());
    engine
        .move_caret(engine.revision(), CaretDirection::Forward)
        .unwrap();
    assert_eq!(engine.selection(), header_end, "the row ends the note");
    let on_row = caret("| a |\n|-".len());
    let revision = engine.revision();
    let affinity = engine.affinity();
    engine.place_selection(revision, on_row, affinity).unwrap();
    assert!(!engine.on_delimiter_row(engine.selection().start.0));

    // Once the header stops reading as one, the row is a plain line.
    let (mut engine, _) = typed_under_header("| a |", &row[..3]);
    let revision = engine.revision();
    engine
        .replace(revision, range(0, 1), "", InputAction::Typing, &mut ok)
        .unwrap();
    assert!(!engine.on_delimiter_row(" a |\n|-".len()) && !engine.writes_delimiter_row());
}

/// Once written, the row is out of reach of words, and Copy over the table
/// copies it.
#[test]
fn a_delimiter_row_holds_no_word_and_copies_with_its_table() {
    let engine = Engine::open("| a |\n|---|\n| b |");
    let row = "| a |\n".len();
    assert!(engine.on_delimiter_row(row) && !engine.on_delimiter_row(row - 1));
    assert_eq!(
        engine.word_at(Revision(0), DisplayOffset(row + 2)).unwrap(),
        caret(row + 2),
        "no word on the row"
    );
    let header = Engine::open("x\n| a |\n|---|");
    let last_word = header
        .word_stop(Revision(0), DisplayOffset(3), CaretDirection::Forward)
        .unwrap();
    assert_eq!(last_word, DisplayOffset(5), "the end of `a`");
    let past = header
        .word_stop(Revision(0), last_word, CaretDirection::Forward)
        .unwrap();
    assert_eq!(past, DisplayOffset(7), "the header's end, not the row");
    let whole = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(header.display_len()),
    };
    assert_eq!(
        header.copy_markdown(Revision(0), whole).unwrap(),
        "x\n| a |\n|---|"
    );
}

/// A caret placed on the delimiter row (a keyboard's cursor swipe arrives as
/// a placed caret) goes on away from where the caret was: from below to the
/// header's end, from above to the next row's start. From the row itself,
/// or from a range, it goes to the nearer edge. A placed range's ends are
/// unchanged by where the selection was.
#[test]
fn a_caret_placed_on_the_delimiter_row_goes_on_the_way_it_came() {
    let note = "| a |\n|---|\n| b |";
    let header_end = caret("| a |".len());
    let next_row = caret("| a |\n|---|\n".len());
    let near_end = caret("| a |\n|---".len());
    let near_start = caret("| a |\n|-".len());
    for (from, placed, want) in [
        (caret("| a |\n|---|\n| b".len()), near_end, header_end),
        (next_row, near_end, header_end),
        (caret(1), near_start, next_row),
        (header_end, near_start, next_row),
        (caret("| a |\n|--".len()), near_end, next_row),
        (range(0, 3), near_start, header_end),
    ] {
        let mut engine = Engine::open(note);
        engine.select(engine.revision(), from).unwrap();
        let (revision, affinity) = (engine.revision(), engine.affinity());
        engine.place_selection(revision, placed, affinity).unwrap();
        assert_eq!(engine.selection(), want, "from {from:?} to {placed:?}");
    }
    let mut engine = Engine::open(note);
    engine.select(engine.revision(), next_row).unwrap();
    let (revision, affinity) = (engine.revision(), engine.affinity());
    let placed = range(2, "| a |\n|---".len());
    engine.place_selection(revision, placed, affinity).unwrap();
    assert_eq!(engine.selection(), range(2, "| a |".len()));
}
