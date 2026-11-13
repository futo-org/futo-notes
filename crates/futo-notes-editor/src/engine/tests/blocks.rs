//! Heading, quote and divider commands: the literal cases in
//! `tests/fixtures/engine/blocks.json`, each also undone and redone.
use super::super::Engine;
use super::{ok, range};
use crate::{Affinity, BlockCommand, DisplayRange, InputAction, ParagraphKey};
use serde::Deserialize;
use std::ops::Range;

#[derive(Deserialize)]
struct Case {
    name: String,
    /// The note, with `|` at the caret or `[` and `]` around the selection,
    /// in source offsets.
    before: String,
    /// A `BlockCommand` (`Heading(2)`, `Quote`, ...), a `ParagraphKey`
    /// (`Enter`, `Backspace`, ...) or `type <text>`.
    command: String,
    /// The note after, marked the same way; equal to `before` when the
    /// command changes nothing.
    after: String,
}

/// `text` without its marks, and the marked source range.
fn unmark(text: &str) -> (String, Range<usize>) {
    if let Some(at) = text.find('|') {
        return (text.replacen('|', "", 1), at..at);
    }
    let start = text.find('[').expect("a caret or a selection");
    let end = text.rfind(']').expect("a selection end") - 1;
    let plain = text.replacen('[', "", 1);
    let mut plain = plain.clone();
    plain.remove(end);
    (plain, start..end)
}

/// The display selection of source `range`; a caret also picks the
/// affinity that puts it at exactly that source offset where one does.
fn display(engine: &Engine, source: &Range<usize>) -> (DisplayRange, Affinity) {
    let (lo, _) = engine.source_bounds(engine.display_of(source.start));
    let affinity = if source.start == lo {
        Affinity::Backward
    } else {
        Affinity::Forward
    };
    let shown = range(
        engine.display_of(source.start),
        engine.display_of(source.end),
    );
    (shown, affinity)
}

/// Run `command` on the engine's selection; whether it changed the note.
fn run(engine: &mut Engine, command: &str) -> bool {
    let selection = engine.selection();
    let revision = engine.revision();
    if let Some(text) = command.strip_prefix("type ") {
        let change = engine
            .input(revision, selection, text, InputAction::Typing, &mut ok)
            .unwrap();
        return change.revision != revision;
    }
    let level = |name: &str| -> Option<u8> {
        let inner = command.strip_prefix(name)?.strip_prefix('(')?;
        inner.strip_suffix(')')?.parse().ok()
    };
    let block = if let Some(level) = level("Heading") {
        Some(BlockCommand::Heading(level))
    } else if let Some(level) = level("ToggleHeading") {
        Some(BlockCommand::ToggleHeading(level))
    } else {
        match command {
            "Quote" => Some(BlockCommand::Quote),
            "Divider" => Some(BlockCommand::Divider),
            _ => None,
        }
    };
    let change = if let Some(block) = block {
        engine.block(revision, selection, block, &mut ok).unwrap()
    } else {
        let key = match command {
            "Enter" => ParagraphKey::Enter,
            "ShiftEnter" => ParagraphKey::ShiftEnter,
            "Backspace" => ParagraphKey::Backspace,
            "BackspaceJoiningHeading" => ParagraphKey::BackspaceJoiningHeading,
            "Delete" => ParagraphKey::Delete,
            other => panic!("unknown command {other:?}"),
        };
        engine.key(revision, selection, key, &mut ok).unwrap()
    };
    change.is_some()
}

#[test]
fn heading_quote_and_divider_cases() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("../../../tests/fixtures/engine/blocks.json")).unwrap();
    assert!(cases.len() >= 60, "{} cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        match std::panic::catch_unwind(|| check(case)) {
            Ok(Ok(())) => {}
            Ok(Err(problem)) => failures.push(format!("{}: {problem}", case.name)),
            Err(_) => failures.push(format!("{}: panicked", case.name)),
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

fn check(case: &Case) -> Result<(), String> {
    let (before, chosen) = unmark(&case.before);
    let (after, landed) = unmark(&case.after);
    let mut engine = Engine::open(&before);
    let (selection, affinity) = display(&engine, &chosen);
    engine
        .select_with_affinity(engine.revision(), selection, affinity)
        .unwrap();
    let opening = (engine.selection(), engine.caret_source());
    if chosen.start == chosen.end && opening.1 != chosen.start {
        return Err(format!("no caret stands at source {}", chosen.start));
    }
    let changed = run(&mut engine, &case.command);
    let got = engine.source_text();
    if got != after {
        return Err(format!("wrote {got:?}, wanted {after:?}"));
    }
    if changed != (before != after) {
        return Err(format!("reported a change: {changed}"));
    }
    if !changed {
        return if engine.can_undo() {
            Err("a command that changed nothing left history".into())
        } else {
            Ok(())
        };
    }
    let (wanted, _) = display(&engine, &landed);
    if engine.selection() != wanted {
        return Err(format!(
            "selection {:?}, wanted {wanted:?}",
            engine.selection()
        ));
    }
    if landed.start == landed.end && engine.caret_source() != landed.start {
        return Err(format!(
            "caret at source {}, wanted {}",
            engine.caret_source(),
            landed.start
        ));
    }
    if engine.display_text() != Engine::open(&after).display_text() {
        return Err("display differs from a fresh read".into());
    }
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    if engine.source_text() != before || (engine.selection(), engine.caret_source()) != opening {
        return Err(format!(
            "undo gave {:?} at {:?}",
            engine.source_text(),
            engine.selection()
        ));
    }
    engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
    if engine.source_text() != after {
        return Err(format!("redo gave {:?}", engine.source_text()));
    }
    Ok(())
}

/// Select display `start..end`, run a block command; whether it changed.
fn block(engine: &mut Engine, start: usize, end: usize, command: BlockCommand) -> bool {
    let selection = range(start, end);
    engine.select(engine.revision(), selection).unwrap();
    let selection = engine.selection();
    engine
        .block(engine.revision(), selection, command, &mut ok)
        .unwrap()
        .is_some()
}

#[test]
fn quote_on_a_whole_table_quotes_it_and_the_guard_keeps_a_table_whole() {
    let table = "| a |\n|---|\n| b |";
    let mut engine = Engine::open(table);
    let all = engine.display_len();
    assert!(block(&mut engine, 0, all, BlockCommand::Quote));
    assert_eq!(engine.source_text(), "> | a |\n> |---|\n> | b |");
    // Quoting the header alone would leave its delimiter row plain.
    let mut engine = Engine::open(table);
    assert!(!block(&mut engine, 0, 0, BlockCommand::Quote));
    assert_eq!(engine.source_text(), table);
    assert!(!engine.can_undo());
    // The last row may leave the table.
    let end = engine.display_len();
    assert!(block(&mut engine, end, end, BlockCommand::Quote));
    assert_eq!(engine.source_text(), "| a |\n|---|\n> | b |");
}

#[test]
fn the_toolbar_shows_the_heading_and_quote_the_toggles_act_on() {
    for (source, start, end, heading, quote) in [
        ("# a", 0, 0, Some(1), false),
        ("> a", 0, 0, Some(0), true),
        ("- a", 0, 0, Some(0), false),
        ("# a\n\nb", 0, 4, None, false),
        ("> # a\n>\n> # b", 0, 4, Some(1), true),
        ("> a\n\n---", 0, 6, Some(0), true),
        ("```\nx\n```", 0, 0, None, false),
        ("a\n\n", 1, 1, Some(0), false),
    ] {
        let mut engine = Engine::open(source);
        engine.select(engine.revision(), range(start, end)).unwrap();
        let toolbar = engine.toolbar();
        assert_eq!(
            (toolbar.heading, toolbar.quote),
            (heading, quote),
            "{source:?} {start}..{end}"
        );
    }
}

/// Quote depth summed over lines, and headings at each level.
fn counts(source: &str) -> (usize, [usize; 7]) {
    let engine = Engine::open(source);
    let mut quotes = 0;
    let mut headings = [0; 7];
    for index in 0..engine.line_count() {
        let line = &engine.line(index).line;
        quotes += line.quote;
        if let crate::lines::Kind::Heading { level } = line.kind {
            headings[usize::from(level)] += 1;
        }
    }
    (quotes, headings)
}

/// For every selection of every note in a small corpus, a lit toolbar
/// button's tap takes the format off, and an unlit one's never does.
#[test]
fn a_lit_toolbar_button_takes_its_format_off_and_an_unlit_one_never_does() {
    let fragments = [
        "a",
        "# a",
        "## a",
        "> a",
        "> # a",
        "> > a",
        ">",
        "",
        "- a",
        "- > a",
        "- # a",
        "1. a",
        "---",
        "```\nx\n```",
        "| a |\n|---|",
    ];
    let mut notes = Vec::new();
    for first in fragments {
        for second in fragments {
            for separator in ["\n", "\n\n"] {
                notes.push(format!("{first}{separator}{second}"));
            }
        }
    }
    let mut checked = 0;
    for note in &notes {
        let before = counts(note);
        let display = Engine::open(note).display_text();
        for start in 0..=display.len() {
            for end in start..=display.len() {
                if !display.is_char_boundary(start) || !display.is_char_boundary(end) {
                    continue;
                }
                let mut probe = Engine::open(note);
                probe.select(probe.revision(), range(start, end)).unwrap();
                let toolbar = probe.toolbar();
                let selection = probe.selection();
                for (command, lit, level) in [
                    (BlockCommand::Quote, toolbar.quote, 0),
                    (
                        BlockCommand::ToggleHeading(1),
                        toolbar.heading == Some(1),
                        1,
                    ),
                    (
                        BlockCommand::ToggleHeading(2),
                        toolbar.heading == Some(2),
                        2,
                    ),
                ] {
                    let mut engine = Engine::open(note);
                    engine.select(engine.revision(), selection).unwrap();
                    engine
                        .block(engine.revision(), selection, command, &mut ok)
                        .unwrap();
                    let after = counts(&engine.source_text());
                    let measure =
                        |c: &(usize, [usize; 7])| if level == 0 { c.0 } else { c.1[level] };
                    let removed = measure(&after) < measure(&before);
                    assert_eq!(
                        removed,
                        lit,
                        "{note:?} {start}..{end} {command:?}: lit {lit}, wrote {:?}",
                        engine.source_text()
                    );
                    checked += 1;
                }
            }
        }
    }
    assert!(checked > 10_000, "{checked}");
}

/// The three keys `tests/long_regions/quotes.rs` presses in a long quote:
/// type at a row's end, Backspace it, Enter.
fn quote_keys(source: &str, needle: &str) -> ([crate::EditWork; 3], String) {
    let mut engine = Engine::open(source);
    let at = engine.display_text().find(needle).unwrap() + needle.len();
    let caret = |at: usize| range(at, at);
    let typed = engine
        .input(
            engine.revision(),
            caret(at),
            "|",
            InputAction::Typing,
            &mut ok,
        )
        .unwrap()
        .work;
    let keys = [ParagraphKey::Backspace, ParagraphKey::Enter];
    let [deleted, entered] = [(at + 1, keys[0]), (at, keys[1])].map(|(at, key)| {
        engine
            .key(engine.revision(), caret(at), key, &mut ok)
            .unwrap()
            .unwrap()
            .work
    });
    ([typed, deleted, entered], engine.source_text())
}

fn total(work: &crate::EditWork) -> usize {
    work.materialized_source_bytes + work.parsed_source_bytes + work.link_metadata_items
}

/// The old engine's work for the same keys (`tests/long_regions/quotes.rs`,
/// measured at e995de29e without the `engine` feature): typing, Backspace,
/// Enter, each summed as `total` sums them.
#[test]
fn keys_in_a_long_quote_do_no_more_work_than_the_old_engine() {
    for (lines, old) in [(2_000, [1085, 977, 1392]), (20_000, [1117, 1039, 1538])] {
        let source: String = (0..lines).map(|i| format!("> quoted row {i}\n")).collect();
        let needle = format!("quoted row {}", lines / 2);
        let (work, after) = quote_keys(&source, &needle);
        assert_eq!(
            after,
            source.replacen(&format!("{needle}\n"), &format!("{needle}\n> \n"), 1)
        );
        for (key, (work, old)) in work.iter().zip(old).enumerate() {
            assert!(
                total(work) <= old,
                "{lines} rows, key {key}: {work:?} > {old}"
            );
        }
    }
}

/// Quote over a whole note of headings, and over a heading and a long code
/// block; the old engine's work for the same commands
/// (`tests/long_regions/block_selection.rs`, at e995de29e without the
/// `engine` feature): metadata items, and `total`.
#[test]
fn quote_over_a_long_selection_does_no_more_work_than_the_old_engine() {
    let headings = |lines: usize| -> (String, String) {
        (
            (0..lines).map(|i| format!("# row {i}\n")).collect(),
            (0..lines).map(|i| format!("> # row {i}\n")).collect(),
        )
    };
    let code = |lines: usize| -> (String, String) {
        let code: String = (0..lines).map(|i| format!("opaque code {i}\n")).collect();
        (
            format!("# heading\n\n```\n{code}```\n"),
            format!("> # heading\n\n```\n{code}```\n"),
        )
    };
    for ((source, expected), old_items, old_total) in [
        (headings(1_000), 168_409, 79_120 + 43_560 + 168_409),
        (headings(4_000), 856_640, 343_120 + 187_560 + 856_640),
        (code(2_000), 135_058, 32_996 + 71_856 + 135_058),
    ] {
        let mut engine = Engine::open(&source);
        let all = range(0, engine.display_len());
        engine.select(engine.revision(), all).unwrap();
        let change = engine
            .block(engine.revision(), all, BlockCommand::Quote, &mut ok)
            .unwrap()
            .unwrap();
        assert_eq!(engine.source_text(), expected);
        let work = change.work;
        assert!(
            work.link_metadata_items <= old_items && total(&work) <= old_total,
            "{work:?}: old {old_items} items, {old_total} in all"
        );
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), source);
        assert_eq!(engine.selection(), all);
    }
}

/// Quote is an exact toggle: quoting whole lines and quoting again returns
/// the note's bytes, whatever blocks the lines are.
#[test]
fn quote_twice_returns_the_exact_bytes() {
    for note in [
        "## Title",
        "- a\n  - b\n\t- c\n    1) d",
        "- [x] done\n- [ ] todo",
        "> q\n# h\n- i\nplain\n  indented",
        "# a\r\n- b\r\n3. c",
        "###### six\n\n1. one",
    ] {
        let mut engine = Engine::open(note);
        let all = range(0, engine.display_text().len());
        engine.select(engine.revision(), all).unwrap();
        for step in ["on", "off"] {
            let selection = engine.selection();
            let changed = engine
                .block(engine.revision(), selection, BlockCommand::Quote, &mut ok)
                .unwrap();
            assert!(changed.is_some(), "{note:?}: quote {step}");
            if step == "on" {
                let quoted: Vec<String> = note
                    .split('\n')
                    .map(|line| {
                        if line.is_empty() {
                            "> ".into()
                        } else {
                            format!("> {line}")
                        }
                    })
                    .collect();
                assert_eq!(engine.source_text(), quoted.join("\n"), "{note:?}");
            }
        }
        assert_eq!(engine.source_text(), note, "{note:?}");
    }
}
