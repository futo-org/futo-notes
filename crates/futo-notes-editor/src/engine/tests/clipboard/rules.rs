//! Paste and cut as actions: round trips, undo steps, marked text, the
//! guard around tables, valid ranges and the work a paste does.
use super::super::super::Engine;
use super::super::{ok, range};
use crate::{Affinity, EditorError, ParagraphKey};

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
    super::super::select(&mut engine, 0, 3, Affinity::Forward);
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
    super::super::select(&mut engine, end, end, Affinity::Forward);
    engine
        .paste_markdown(engine.revision(), engine.selection(), &copied, &mut ok)
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), "- a\n  - b\n    - c\n- d\n- b\n  - c");
}

#[test]
fn paste_and_cut_are_each_their_own_undo_step() {
    let mut engine = Engine::open("ab");
    super::super::select(&mut engine, 2, 2, Affinity::Forward);
    super::super::typed(&mut engine, "c");
    engine
        .paste_markdown(engine.revision(), engine.selection(), "x", &mut ok)
        .unwrap()
        .unwrap();
    super::super::typed(&mut engine, "d");
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
    super::super::select(&mut engine, 1, 1, Affinity::Forward);
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
            super::super::select(&mut engine, at, at, Affinity::Forward);
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
        super::super::select(&mut engine, end, end, Affinity::Forward);
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
        super::super::select(&mut engine, middle, middle, Affinity::Forward);
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
    super::super::select(&mut engine, 1, 1, Affinity::Backward);
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
