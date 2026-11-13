//! Copy, cut and paste: the literal cases in
//! `tests/fixtures/engine/clipboard/`, and the rules a table cannot show.
//!
//! Each case marks the selection in its source with `|` (a caret) or `[`
//! and `]` (`marks` names other characters when the note needs these), runs
//! `copy`, `cut`, `paste` (of `text`) or a plain line's `Enter` or
//! `ShiftEnter` there, and states the source and
//! selection after it, and what `copy` and `cut` copied. Every case that
//! changes the note also checks the view change a renderer applies, undoes
//! to the exact bytes and selection, and redoes to the result.
use super::super::Engine;
use super::{ok, range};
use crate::{Affinity, DisplayRange, EditorError, InlineFormat, ParagraphKey, SourceEdit};

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    before: String,
    command: String,
    after: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    copied: Option<String>,
    #[serde(default)]
    marks: Option<String>,
}

/// The note without its marks, and the marked source range.
fn unmark(marked: &str, marks: &[char; 3]) -> (String, std::ops::Range<usize>) {
    let mut text = String::new();
    let (mut start, mut end) = (None, None);
    for ch in marked.chars() {
        if ch == marks[0] {
            start = Some(text.len());
            end = Some(text.len());
        } else if ch == marks[1] {
            start = Some(text.len());
        } else if ch == marks[2] {
            end = Some(text.len());
        } else {
            text.push(ch);
        }
    }
    (
        text,
        start.expect("a selection")..end.expect("a selection end"),
    )
}

/// Select source `selection`, on the side of hidden text it names.
fn select_source(engine: &mut Engine, selection: std::ops::Range<usize>) {
    let (start, end) = (
        engine.display_of(selection.start),
        engine.display_of(selection.end),
    );
    let (lo, _) = engine.source_bounds(start);
    let affinity = if lo == selection.start {
        Affinity::Backward
    } else {
        Affinity::Forward
    };
    super::select(engine, start, end, affinity);
}

fn display_selection(engine: &Engine, selection: &std::ops::Range<usize>) -> DisplayRange {
    range(
        engine.display_of(selection.start),
        engine.display_of(selection.end),
    )
}

/// Run one case's command; what it copied, and whether it changed the
/// note. The view change is applied to `view`.
fn run(engine: &mut Engine, case: &Case, view: &mut String) -> String {
    let (revision, selection) = (engine.revision(), engine.selection());
    let mut records = 0;
    let mut count = |_: &SourceEdit| -> Result<(), String> {
        records += 1;
        Ok(())
    };
    let (copied, change) = match case.command.as_str() {
        "copy" => (engine.copy_markdown(revision, selection).unwrap(), None),
        "cut" => engine
            .cut_markdown(revision, selection, &mut count)
            .unwrap(),
        "paste" => {
            let text = case.text.as_deref().expect("pasted text");
            let change = engine
                .paste_markdown(revision, selection, text, &mut count)
                .unwrap();
            (String::new(), change)
        }
        "Enter" | "ShiftEnter" => {
            let key = if case.command == "Enter" {
                ParagraphKey::Enter
            } else {
                ParagraphKey::ShiftEnter
            };
            let change = engine.key(revision, selection, key, &mut count).unwrap();
            (String::new(), change)
        }
        other => panic!("unknown command {other:?}"),
    };
    if let Some(change) = change {
        assert_eq!(records, 1, "{}: one acceptance", case.name);
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    } else {
        assert_eq!(records, 0, "{}: no acceptance", case.name);
    }
    copied
}

#[test]
fn clipboard_cases() {
    let cases: Vec<Case> = [
        include_str!("../../../tests/fixtures/engine/clipboard/paste.json"),
        include_str!("../../../tests/fixtures/engine/clipboard/copy-and-cut.json"),
        include_str!("../../../tests/fixtures/engine/clipboard/plain-enter.json"),
    ]
    .into_iter()
    .flat_map(|file| serde_json::from_str::<Vec<Case>>(file).unwrap())
    .collect();
    assert!(cases.len() >= 100, "{} cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let marks: Vec<char> = case.marks.as_deref().unwrap_or("|[]").chars().collect();
        let marks = [marks[0], marks[1], marks[2]];
        let (source, selection) = unmark(&case.before, &marks);
        let (want, want_selection) = unmark(&case.after, &marks);
        let mut engine = Engine::open(&source);
        select_source(&mut engine, selection);
        let opening = engine.source_text();
        let opening_selection = engine.selection();
        let groups = engine.history.undo.len();
        let mut view = engine.display_text();
        let copied = run(&mut engine, case, &mut view);
        if let Some(expected) = &case.copied {
            if &copied != expected {
                failures.push(format!(
                    "{}: copied {copied:?}, want {expected:?}",
                    case.name
                ));
                continue;
            }
        }
        let got = engine.source_text();
        let got_selection = engine.selection();
        let fresh = Engine::open(&got);
        if got != want || got_selection != display_selection(&fresh, &want_selection) {
            failures.push(format!(
                "{}: got {got:?} selection {got_selection:?}, want {want:?} selection {:?}",
                case.name,
                display_selection(&fresh, &want_selection)
            ));
            continue;
        }
        assert_eq!(engine.display_text(), fresh.display_text(), "{}", case.name);
        assert_eq!(view, engine.display_text(), "{}: view change", case.name);
        if got == opening {
            if engine.history.undo.len() != groups {
                failures.push(format!("{}: no change left history", case.name));
            }
            continue;
        }
        assert_eq!(engine.history.undo.len(), groups + 1, "{}", case.name);
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        if engine.source_text() != opening || engine.selection() != opening_selection {
            failures.push(format!(
                "{}: undo gave {:?} at {:?}",
                case.name,
                engine.source_text(),
                engine.selection()
            ));
            continue;
        }
        engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
        if engine.source_text() != want || engine.selection() != got_selection {
            failures.push(format!(
                "{}: redo gave {:?}",
                case.name,
                engine.source_text()
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn cut_carries_the_cut_formats_to_the_next_typed_character() {
    let mut engine = Engine::open("a **bold** c");
    super::select(&mut engine, 2, 6, Affinity::Forward);
    let (copied, change) = engine
        .cut_markdown(engine.revision(), engine.selection(), &mut ok)
        .unwrap();
    assert_eq!(copied, "**bold**");
    assert!(change.is_some());
    assert_eq!(engine.source_text(), "a  c");
    assert_eq!(engine.active_formats(), vec![InlineFormat::Bold]);
    // Undo takes the cut back; Redo carries the formats again.
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "a **bold** c");
    assert_eq!(engine.selection(), range(2, 6));
    engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.active_formats(), vec![InlineFormat::Bold]);
    super::typed(&mut engine, "x");
    assert_eq!(engine.source_text(), "a **x** c");
    // Cut and typing are two Undo steps.
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "a  c");
}

#[test]
fn a_one_line_paste_takes_the_formats_the_caret_carries() {
    for (format, want) in [
        (InlineFormat::Bold, "a **x y** b"),
        (InlineFormat::Code, "a `x y` b"),
    ] {
        let mut engine = Engine::open("a  b");
        super::select(&mut engine, 2, 2, Affinity::Forward);
        engine
            .toggle_format_view(engine.revision(), format, &mut ok)
            .unwrap();
        engine
            .paste_markdown(engine.revision(), range(2, 2), "x y", &mut ok)
            .unwrap()
            .unwrap();
        assert_eq!(engine.source_text(), want);
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), "a  b");
    }
}

#[test]
fn a_paste_across_table_cells_is_refused() {
    let note = "| a | b |\n|---|---|\n| x | y |";
    let mut engine = Engine::open(note);
    let display = engine.display_text();
    let (x, y) = (display.find('x').unwrap(), display.find('y').unwrap());
    let refused = engine.paste_markdown(engine.revision(), range(x, y + 1), "q", &mut ok);
    assert_eq!(refused, Err(EditorError::UnrepresentableFormat));
    assert_eq!(engine.source_text(), note);
    assert!(!engine.can_undo());
}

#[test]
fn cut_then_paste_puts_quote_lines_back() {
    let mut engine = Engine::open("> a\n> b\nz");
    super::select(&mut engine, 0, 3, Affinity::Forward);
    let (copied, _) = engine
        .cut_markdown(engine.revision(), engine.selection(), &mut ok)
        .unwrap();
    assert_eq!(engine.source_text(), "> \nz");
    engine
        .paste_markdown(engine.revision(), engine.selection(), &copied, &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "> a\n> b\nz");
}

#[test]
fn copy_then_paste_of_nested_items_lands_beside_the_caret_item() {
    let mut engine = Engine::open("- a\n  - b\n    - c\n- d");
    let copied = engine
        .copy_markdown(engine.revision(), range(2, 5))
        .unwrap();
    assert_eq!(copied, "- b\n  - c");
    let end = engine.display_len();
    super::select(&mut engine, end, end, Affinity::Forward);
    engine
        .paste_markdown(engine.revision(), engine.selection(), &copied, &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "- a\n  - b\n    - c\n- d\n- b\n  - c");
}

#[test]
fn paste_and_cut_are_each_their_own_undo_step() {
    let mut engine = Engine::open("ab");
    super::select(&mut engine, 2, 2, Affinity::Forward);
    super::typed(&mut engine, "c");
    engine
        .paste_markdown(engine.revision(), engine.selection(), "x", &mut ok)
        .unwrap()
        .unwrap();
    super::typed(&mut engine, "d");
    assert_eq!(engine.source_text(), "abcxd");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "abcx");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "abc");
    assert_eq!(engine.selection(), range(3, 3));
}

#[test]
fn paste_over_marked_text_commits_it_first() {
    let mut engine = Engine::open("a");
    super::select(&mut engine, 1, 1, Affinity::Forward);
    engine
        .compose(engine.revision(), range(1, 1), "か")
        .unwrap();
    // The host's caret is after the marked text.
    let after = 1 + "か".len();
    engine
        .paste_markdown(engine.revision(), range(after, after), "x\ny", &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "aかx\ny");
    // The commit and the paste are two undo steps.
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "aか");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), "a");
}

#[test]
fn paste_never_changes_how_another_table_line_reads() {
    // Single-cell paste is the tables family's; until then, a paste that
    // would split a row above others is cancelled by the guard.
    let note = "| a | b |\n|---|---|\n| x | y |\n| z | w |";
    let kinds = |engine: &Engine| -> Vec<_> {
        (0..engine.line_count())
            .map(|index| engine.line(index).line.kind.clone())
            .collect()
    };
    let table = kinds(&Engine::open(note));
    let display = Engine::open(note).display_text();
    for at in (0..=display.len()).filter(|&at| display.is_char_boundary(at)) {
        for text in ["1\n2", "- a\n- b", "```\ncode"] {
            let mut engine = Engine::open(note);
            super::select(&mut engine, at, at, Affinity::Forward);
            let line = engine.line_of(engine.caret_source());
            if line < 2 {
                continue;
            }
            let _ = engine.paste_markdown(engine.revision(), range(at, at), text, &mut ok);
            let now = kinds(&engine);
            for (index, kind) in table.iter().enumerate() {
                if index != line && index + 1 != line {
                    let moved = index + now.len() - table.len();
                    let index = if index > line { moved } else { index };
                    assert_eq!(&now[index], kind, "{text:?} at {at}: line {index}");
                }
            }
        }
    }
}

#[test]
fn no_valid_range_is_answered_invalid_range() {
    // #355: every range on a character boundary, for copy, cut and pastes,
    // over notes with lists, tables, fences, CRLF and non-ASCII text.
    for note in [
        "- a\n- b\n",
        "1. é \nIntro with x\n",
        "- a\r\n- b\r\n",
        "- 😀 a\n- b é\n\ttail\n",
        "- a\n\t- b\n\t- c\n- d\n",
        "# h\n\n- a\n- b\n\nend\n",
        "x\n\n```\ncode\n```\n\n- a\n- b\n",
        "| a | b |\n|---|---|\n| é | 2 |\n\nz\n",
        "| a |\n| - |\n| b |Heading one\n\nx\n",
        "| 😀 | b |\r\n|---|---|\r\n| 1 | 2 |\r\n",
        "- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
        "---\nt: x\n---\n> **a** [l](u)\n```\n",
    ] {
        let display = Engine::open(note).display_text();
        let bounds: Vec<usize> = (0..=display.len())
            .filter(|&at| display.is_char_boundary(at))
            .collect();
        for &a in &bounds {
            for &b in bounds.iter().filter(|&&b| b >= a) {
                let at = range(a, b);
                let mut engine = Engine::open(note);
                let copied = engine.copy_markdown(engine.revision(), at);
                assert_ne!(
                    copied,
                    Err(EditorError::InvalidRange),
                    "copy {at:?} of {note:?}"
                );
                for text in ["plain", "- a\n- b", "x\n```\ny"] {
                    let mut engine = Engine::open(note);
                    let pasted = engine.paste_markdown(engine.revision(), at, text, &mut ok);
                    if let Err(error) = pasted {
                        // A selection across table cells is refused for
                        // what the paste would do, not as an invalid range.
                        assert!(
                            error == EditorError::UnrepresentableFormat
                                || engine.touches_metadata(at),
                            "paste {text:?} {at:?} of {note:?}: {error:?}"
                        );
                    }
                }
                let cut = engine.cut_markdown(engine.revision(), at, &mut ok);
                if let Err(error) = cut {
                    assert!(
                        engine.touches_metadata(at),
                        "cut {at:?} of {note:?}: {error:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn paste_work_does_not_grow_with_the_note() {
    // As the old engine's test: 4,000 pasted lines at the end of a note of
    // 10 and of 20,000 paragraphs.
    let pasted: String = (0..2000).map(|i| format!("line {i}\n\n")).collect();
    let work = |paragraphs: usize| {
        let source = "para\n\n".repeat(paragraphs) + "ab";
        let mut engine = Engine::open(&source);
        let end = engine.display_len();
        super::select(&mut engine, end, end, Affinity::Forward);
        let change = engine
            .paste_markdown(engine.revision(), range(end, end), &pasted, &mut ok)
            .unwrap()
            .unwrap();
        change.work.parsed_source_bytes + change.work.materialized_source_bytes
    };
    let (small, large) = (work(10), work(20_000));
    assert!(large <= small + 64, "small {small}, large {large}");
    // The old engine counted 110,451 here at both sizes (62,672 now).
    assert!(small <= 110_451, "small {small}");
}

#[test]
fn a_paste_mid_note_reads_only_its_own_lines() {
    // A paste in the middle of a 20,000-line note: work proportional to the
    // pasted text and the caret's line, not the note.
    let pasted = "- one\n- two\n\n> three";
    let work = |lines: usize| {
        let source = "para\n".repeat(lines);
        let mut engine = Engine::open(&source);
        let middle = engine.display_of(engine.line_start(lines / 2) + 2);
        super::select(&mut engine, middle, middle, Affinity::Forward);
        engine
            .paste_markdown(engine.revision(), range(middle, middle), pasted, &mut ok)
            .unwrap()
            .unwrap()
            .work
    };
    let (small, large) = (work(100), work(20_000));
    assert_eq!(small.parsed_source_bytes, large.parsed_source_bytes);
    assert_eq!(
        small.materialized_source_bytes,
        large.materialized_source_bytes
    );
}

#[test]
fn enter_at_a_bold_end_during_composition_splits_after_the_bold() {
    // The old composition test's Enter row: the marked text commits inside
    // the bold, then Enter breaks the line after the bold's closing.
    let mut engine = Engine::open("**b** x");
    super::select(&mut engine, 1, 1, Affinity::Backward);
    engine
        .compose(engine.revision(), range(1, 1), "か")
        .unwrap();
    engine
        .key(engine.revision(), range(4, 4), ParagraphKey::Enter, &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "**bか**\n x");
    assert_eq!(engine.selection(), range(5, 5));
}
