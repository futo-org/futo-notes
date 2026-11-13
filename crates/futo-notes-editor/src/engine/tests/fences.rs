//! Fenced code: the literal cases in `tests/fixtures/engine/fences.json`.
//!
//! Each case marks the selection in its source with `|` (a caret) or `[`
//! and `]` (`marks` names other characters when the note needs these), runs
//! one command or key (`type:` text typed, `os:` a text service's
//! replacement of the selection), and states the source and selection after it. When
//! `typed` is set, that text is typed at the selection first (setup, not
//! checked). Every case that changes the note also undoes to the exact
//! bytes and selection, and redoes to the result.
use super::super::Engine;
use super::{ok, range};
use crate::{Affinity, BlockCommand, DisplayRange, InputAction, ParagraphKey};

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    before: String,
    command: String,
    after: String,
    #[serde(default)]
    typed: Option<String>,
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
    let start = start.expect("a selection mark");
    (text, start..end.expect("a selection end"))
}

/// Select source `selection`, on the side of hidden text it names.
fn select_source(engine: &mut Engine, selection: std::ops::Range<usize>) {
    let display = |at: usize| engine.display_of(at);
    let (start, end) = (display(selection.start), display(selection.end));
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

fn run(engine: &mut Engine, command: &str) {
    let selection = engine.selection();
    let revision = engine.revision();
    let block = |name: &str| match name {
        "CodeBlock" => Some(BlockCommand::CodeBlock),
        "WrapCodeBlock" => Some(BlockCommand::WrapCodeBlock),
        "Indent" => Some(BlockCommand::Indent),
        "Outdent" => Some(BlockCommand::Outdent),
        _ => None,
    };
    let key = |name: &str| match name {
        "Enter" => Some(ParagraphKey::Enter),
        "ShiftEnter" => Some(ParagraphKey::ShiftEnter),
        "Tab" => Some(ParagraphKey::Tab),
        "ShiftTab" => Some(ParagraphKey::ShiftTab),
        "Backspace" => Some(ParagraphKey::Backspace),
        "Delete" => Some(ParagraphKey::Delete),
        _ => None,
    };
    if let Some(text) = command.strip_prefix("type:") {
        engine
            .replace(revision, selection, text, InputAction::Typing, &mut ok)
            .unwrap();
    } else if let Some(text) = command.strip_prefix("os:") {
        engine
            .replace(revision, selection, text, InputAction::Isolated, &mut ok)
            .unwrap();
    } else if let Some(command) = block(command) {
        engine.block(revision, selection, command, &mut ok).unwrap();
    } else if let Some(key) = key(command) {
        engine.key(revision, selection, key, &mut ok).unwrap();
    } else {
        panic!("unknown command {command:?}");
    }
}

#[test]
fn fence_cases() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("../../../tests/fixtures/engine/fences.json")).unwrap();
    assert!(cases.len() >= 60, "{} cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let marks: Vec<char> = case.marks.as_deref().unwrap_or("|[]").chars().collect();
        let marks = [marks[0], marks[1], marks[2]];
        let (source, selection) = unmark(&case.before, &marks);
        let (want, want_selection) = unmark(&case.after, &marks);
        let mut engine = Engine::open(&source);
        select_source(&mut engine, selection.clone());
        if let Some(text) = &case.typed {
            let at = engine.selection();
            engine
                .replace(engine.revision(), at, text, InputAction::Typing, &mut ok)
                .unwrap();
        }
        let opening = engine.source_text();
        let opening_selection = engine.selection();
        let groups = engine.history.undo.len();
        run(&mut engine, &case.command);
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
        if got == opening {
            if engine.history.undo.len() != groups {
                failures.push(format!("{}: no change left history", case.name));
            }
            continue;
        }
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        if engine.source_text() != opening || engine.selection() != opening_selection {
            failures.push(format!(
                "{}: undo gave {:?} {:?}",
                case.name,
                engine.source_text(),
                engine.selection()
            ));
            continue;
        }
        engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
        if engine.source_text() != want || engine.selection() != got_selection {
            failures.push(format!(
                "{}: redo gave {:?} {:?}",
                case.name,
                engine.source_text(),
                engine.selection()
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn the_toolbar_reads_code_from_the_caret_line() {
    for (source, caret, code, indent, outdent) in [
        ("```\ncode\n```", 2, true, true, false),
        ("```\n\tcode\n```", 2, true, true, true),
        ("```\n```", 0, true, true, false),
        ("```\ncode\n```\n", 4, true, true, false),
        ("```\ncode\n```\nprose", 7, false, false, false),
    ] {
        let mut engine = Engine::open(source);
        super::select(&mut engine, caret, caret, Affinity::Backward);
        let toolbar = engine.toolbar();
        assert_eq!(toolbar.code, code, "{source:?}");
        assert_eq!(toolbar.inline_allowed, !code, "{source:?}");
        assert_eq!(
            (toolbar.can_indent, toolbar.can_outdent),
            (indent, outdent),
            "{source:?}"
        );
    }
}

/// The "fenced code" shape of `tests/long_regions.rs`: type `|` in the
/// middle line of one long block, Backspace it, then Enter. Its counted
/// work (materialized plus parsed bytes plus description items) is no
/// higher than the old engine's, measured by that test without the
/// `engine` feature: 1,000 lines [649, 553, 660], 20,000 [963, 885, 1018].
#[test]
fn keys_in_a_long_block_cost_no_more_than_the_old_engine() {
    for (lines, old) in [(1_000, [649, 553, 660]), (20_000, [963, 885, 1018])] {
        let source: String = std::iter::once("```rust\n".to_owned())
            .chain((0..lines).map(|i| format!("code {i}\n")))
            .chain(std::iter::once("```\n".to_owned()))
            .collect();
        let middle = format!("code {}", lines / 2);
        let expected = source.replace(&format!("{middle}\n"), &format!("{middle}\n\n"));
        let mut engine = Engine::open(&source);
        let at = engine.display_text().find(&middle).unwrap() + middle.len();
        let typed = engine
            .input(
                engine.revision(),
                range(at, at),
                "|",
                InputAction::Typing,
                &mut ok,
            )
            .unwrap()
            .work;
        let key = |engine: &mut Engine, at: usize, key: ParagraphKey| {
            engine
                .key(engine.revision(), range(at, at), key, &mut ok)
                .unwrap()
                .unwrap()
                .work
        };
        let deleted = key(&mut engine, at + 1, ParagraphKey::Backspace);
        let entered = key(&mut engine, at, ParagraphKey::Enter);
        assert_eq!(engine.source_text(), expected, "{lines}");
        let new = [typed, deleted, entered].map(|work| {
            work.materialized_source_bytes + work.parsed_source_bytes + work.link_metadata_items
        });
        assert!(
            new.iter().zip(old).all(|(new, old)| *new <= old),
            "{lines} lines: {new:?}, old {old:?}"
        );
    }
}
