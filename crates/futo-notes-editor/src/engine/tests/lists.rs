//! The list family's literal cases, `tests/fixtures/engine/lists/*.json`: text
//! and selection before, a key, toolbar command or typed text, and text and
//! selection after. In `before` and `after` a `‸` marks a caret and `«` `»`
//! a selection, at source offsets. Every case that changes the note is also
//! undone (exact bytes and selection back) and redone.
use super::{ok, range};
use crate::engine::Engine;
use crate::{Affinity, BlockCommand, DisplayRange, InputAction, ParagraphKey};
use serde::Deserialize;
use std::ops::Range;

#[derive(Deserialize)]
struct Case {
    name: String,
    before: String,
    command: String,
    after: String,
}

/// The text without its marks, and the marked source range.
fn unmark(marked: &str) -> (String, Range<usize>) {
    let mut text = String::new();
    let (mut start, mut end) = (None, None);
    for ch in marked.chars() {
        match ch {
            '‸' => {
                assert!(start.is_none(), "one caret: {marked:?}");
                start = Some(text.len());
                end = Some(text.len());
            }
            '«' => start = Some(text.len()),
            '»' => end = Some(text.len()),
            ch => text.push(ch),
        }
    }
    let (Some(start), Some(end)) = (start, end) else {
        panic!("no selection in {marked:?}");
    };
    (text, start..end)
}

/// Select source `selected`: a caret at exactly that source offset.
fn select_source(engine: &mut Engine, selected: Range<usize>) {
    let (start, end) = (
        engine.display_of(selected.start),
        engine.display_of(selected.end),
    );
    let affinity = if selected.is_empty() && engine.source_bounds(start).0 == selected.start {
        Affinity::Backward
    } else {
        Affinity::Forward
    };
    engine
        .select_with_affinity(engine.revision(), range(start, end), affinity)
        .unwrap();
    assert_eq!(
        engine.source_selection(engine.selection()),
        selected,
        "the marks sit where a selection can"
    );
}

/// The selection, in source offsets: a caret's exact source offset.
fn selected_source(engine: &Engine) -> Range<usize> {
    let selection = engine.selection();
    if selection.start == selection.end {
        let at = engine.caret_source();
        return at..at;
    }
    engine.source_selection(selection)
}

fn run(engine: &mut Engine, command: &str) -> bool {
    let selection: DisplayRange = engine.selection();
    let revision = engine.revision();
    let key = match command {
        "Enter" => Some(ParagraphKey::Enter),
        "ShiftEnter" => Some(ParagraphKey::ShiftEnter),
        "Backspace" => Some(ParagraphKey::Backspace),
        "BackspaceJoiningHeading" => Some(ParagraphKey::BackspaceJoiningHeading),
        "Delete" => Some(ParagraphKey::Delete),
        "Tab" => Some(ParagraphKey::Tab),
        "ShiftTab" => Some(ParagraphKey::ShiftTab),
        _ => None,
    };
    if let Some(key) = key {
        return engine
            .key(revision, selection, key, &mut ok)
            .unwrap()
            .is_some();
    }
    if let Some(text) = command.strip_prefix("type:") {
        let change = engine
            .input(revision, selection, text, InputAction::Typing, &mut ok)
            .unwrap();
        return change.revision != revision;
    }
    let command = match command {
        "Indent" => BlockCommand::Indent,
        "Outdent" => BlockCommand::Outdent,
        "BulletList" => BlockCommand::BulletList,
        "OrderedList" => BlockCommand::OrderedList,
        "TaskList" => BlockCommand::TaskList,
        "ToggleTask" => BlockCommand::ToggleTask,
        other => panic!("unknown command {other:?}"),
    };
    engine
        .block(revision, selection, command, &mut ok)
        .unwrap()
        .is_some()
}

#[test]
fn list_cases() {
    let cases: Vec<Case> = [
        include_str!("../../../tests/fixtures/engine/lists/enter.json"),
        include_str!("../../../tests/fixtures/engine/lists/backspace-delete.json"),
        include_str!("../../../tests/fixtures/engine/lists/indent.json"),
        include_str!("../../../tests/fixtures/engine/lists/toggles.json"),
        include_str!("../../../tests/fixtures/engine/lists/typed.json"),
    ]
    .into_iter()
    .flat_map(|file| serde_json::from_str::<Vec<Case>>(file).unwrap())
    .collect();
    let mut failures = Vec::new();
    for case in &cases {
        let (before, selected) = unmark(&case.before);
        let (after, landed) = unmark(&case.after);
        let mut engine = Engine::open(&before);
        select_source(&mut engine, selected.clone());
        let opening = engine.selection();
        let changed = run(&mut engine, &case.command);
        let got = (engine.source_text(), selected_source(&engine));
        if got != (after.clone(), landed.clone()) {
            failures.push(format!(
                "{}\n    want {:?} at {landed:?}\n    got  {:?} at {:?}",
                case.name, after, got.0, got.1
            ));
            continue;
        }
        assert_eq!(changed, before != after, "{}", case.name);
        assert_eq!(
            engine.display_text(),
            Engine::open(&after).display_text(),
            "{}: the display equals a fresh read",
            case.name
        );
        if before == after {
            assert!(!engine.can_undo(), "{}: no change, no history", case.name);
            continue;
        }
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), before, "{}: undo", case.name);
        assert_eq!(
            engine.selection(),
            opening,
            "{}: undo's selection",
            case.name
        );
        engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), after, "{}: redo", case.name);
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
fn the_toolbar_offers_indent_on_items_and_outdent_on_indented_items() {
    for (source, caret, indents) in [
        ("plain", 0, (false, false)),
        ("# heading", 0, (false, false)),
        ("> quote", 0, (false, false)),
        ("- item", 0, (true, false)),
        ("1. item", 0, (true, false)),
        ("> - item", 0, (true, false)),
        ("- a\n\t- b", 2, (true, true)),
        ("- a\n  - [ ] b", 2, (true, true)),
    ] {
        let mut engine = Engine::open(source);
        super::select(&mut engine, caret, caret, Affinity::Forward);
        let toolbar = engine.toolbar();
        assert_eq!(
            (toolbar.can_indent, toolbar.can_outdent),
            indents,
            "{source:?}"
        );
    }
}

/// Counted work: materialized and parsed source and metadata items, the
/// sum the old engine's `tests/long_regions*` budgets measure.
fn total(work: &crate::EditWork) -> usize {
    work.materialized_source_bytes + work.parsed_source_bytes + work.link_metadata_items
}

fn key_at(engine: &mut Engine, at: usize, key: ParagraphKey) -> (usize, usize) {
    let change = engine
        .key(engine.revision(), range(at, at), key, &mut ok)
        .unwrap()
        .unwrap();
    (total(&change.work), change.selection.end.0)
}

/// `tests/long_regions.rs` `an_emptied_item_in_a_nested_list_stays_local`
/// on the core: Enter at a nested item's end, Backspace on the new empty
/// item, then typing. The old engine counted (Enter, Backspace, typing)
/// 1157, 1082, 1248 at 1,000 lines and 1347, 1372, 1482 at 20,000.
#[test]
fn an_emptied_item_in_a_nested_list_costs_no_more_than_before() {
    const DEPTHS: [usize; 12] = [0, 1, 2, 3, 4, 5, 6, 5, 6, 4, 5, 3];
    let line = |i: usize| {
        let indent = "    ".repeat(DEPTHS[i % 12]);
        match i % 4 {
            0 => format!("{indent}- ### Encounters n{i}z\n"),
            1 => format!("{indent}- 1d4 [owl {i}](https://example.com/owl-{i})s n{i}z\n"),
            2 => format!("{indent}- **d100** n{i}z\n"),
            _ => format!("{indent}- {:02}–{:02} n{i}z\n", i % 100, (i + 2) % 100),
        }
    };
    for (lines, old) in [(1_000, [1157, 1082, 1248]), (20_000, [1347, 1372, 1482])] {
        let source: String = (0..lines).map(line).collect();
        let middle = (lines / 2..).find(|&i| i % 12 == 6 && i % 4 != 0).unwrap();
        let mut engine = Engine::open(&source);
        let needle = format!("n{middle}z");
        let at = engine.display_text().find(&needle).unwrap() + needle.len();
        let (entered, at) = key_at(&mut engine, at, ParagraphKey::Enter);
        let (emptied, at) = key_at(&mut engine, at, ParagraphKey::Backspace);
        let typed = engine
            .input(
                engine.revision(),
                range(at, at),
                "x",
                InputAction::Typing,
                &mut ok,
            )
            .unwrap();
        let text = line(middle);
        assert_eq!(
            engine.source_text(),
            source.replacen(&text, &format!("{text}x\n"), 1),
            "{lines}"
        );
        let now = [entered, emptied, total(&typed.work)];
        for (key, (now, old)) in now.iter().zip(old).enumerate() {
            assert!(*now <= old, "{lines} lines, key {key}: {now} > {old}");
        }
    }
}

/// `tests/long_regions.rs`
/// `outdenting_an_empty_nested_item_reads_only_its_parents_list` on the
/// core: Enter twice at a nested item's end (the second outdents the new
/// empty item), bullets and numbers. The old engine counted (first, second
/// Enter) at 1,200 and 24,000 lines: bullets 1379, 1228 and 1827, 1732;
/// numbers 1390, 1243 and 1838, 1747.
#[test]
fn outdenting_an_empty_nested_item_costs_no_more_than_before() {
    const DEPTHS: [usize; 6] = [0, 1, 2, 2, 2, 1];
    for ordered in [false, true] {
        let line = |i: usize| {
            let depth = DEPTHS[i % 6];
            let indent = "    ".repeat(depth);
            let marker = if ordered && depth > 0 {
                let at = i % 6;
                let number = if depth == 1 {
                    usize::from(at == 5) + 1
                } else {
                    at - 1
                };
                format!("{number}.")
            } else {
                "-".to_owned()
            };
            format!("{indent}{marker} [owl {i}](https://example.com/owl-{i}) n{i}z\n")
        };
        let old = if ordered {
            [(1_200, [1390, 1243]), (24_000, [1838, 1747])]
        } else {
            [(1_200, [1379, 1228]), (24_000, [1827, 1732])]
        };
        for (lines, old) in old {
            let source: String = (0..lines).map(line).collect();
            let middle = (lines / 2..).find(|&i| i % 6 == 2).unwrap();
            let mut engine = Engine::open(&source);
            let needle = format!("n{middle}z");
            let at = engine.display_text().find(&needle).unwrap() + needle.len();
            let (first, at) = key_at(&mut engine, at, ParagraphKey::Enter);
            let (second, _) = key_at(&mut engine, at, ParagraphKey::Enter);
            // The empty item sits one level out after the middle item; the
            // two items after it now sit under it and count again from 1,
            // and the next item at its level is bumped.
            let (a, b, c, d) = (
                line(middle),
                line(middle + 1),
                line(middle + 2),
                line(middle + 3),
            );
            let after = if ordered {
                format!(
                    "{a}    2. \n{}{}{}",
                    b.replacen("2.", "1.", 1),
                    c.replacen("3.", "2.", 1),
                    d.replacen("2.", "3.", 1)
                )
            } else {
                format!("{a}    - \n{b}{c}{d}")
            };
            assert_eq!(
                engine.source_text(),
                source.replacen(&format!("{a}{b}{c}{d}"), &after, 1),
                "ordered {ordered} at {lines}"
            );
            for (key, (now, old)) in [first, second].iter().zip(old).enumerate() {
                assert!(
                    *now <= old,
                    "ordered {ordered}, {lines} lines, key {key}: {now} > {old}"
                );
            }
        }
    }
}

/// `tests/long_regions/list_toggle.rs`
/// `removing_one_middle_bullet_reads_only_its_neighboring_rows` on the
/// core. The old engine counted 770 at 1,000 lines and 1099 at 20,000.
#[test]
fn removing_one_middle_bullet_costs_no_more_than_before() {
    for (lines, old) in [(1_000, 770), (20_000, 1099)] {
        let source: String = (0..lines).map(|i| format!("- item {i}\n")).collect();
        let needle = format!("item {}", lines / 2);
        let mut engine = Engine::open(&source);
        let at = engine.display_text().find(&needle).unwrap();
        super::select(&mut engine, at, at, Affinity::Backward);
        let change = engine
            .block(
                engine.revision(),
                range(at, at),
                BlockCommand::BulletList,
                &mut ok,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            engine.source_text(),
            source.replacen(&format!("- {needle}\n"), &format!("{needle}\n"), 1)
        );
        let now = total(&change.work);
        assert!(now <= old, "{lines} lines: {now} > {old}");
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(engine.source_text(), source);
        assert_eq!(engine.selection(), range(at, at));
    }
}

/// `tests/long_regions/block_selection.rs`
/// `list_commands_do_not_compare_every_span_with_every_line_boundary` on
/// the core: 1,000 bold headings become bullets. The old engine counted
/// 1,158,673 in all, 527,505 of it metadata items (budget 1,000 × (512 +
/// 8 × 10)).
#[test]
fn a_whole_note_list_toggle_costs_no_more_than_before() {
    let lines = 1_000usize;
    let source: String = (0..lines).map(|i| format!("# **row {i}**\n")).collect();
    let expected: String = (0..lines).map(|i| format!("- **row {i}**\n")).collect();
    let mut engine = Engine::open(&source);
    let end = engine.display_len();
    let selected = range(0, end);
    super::select(&mut engine, 0, end, Affinity::Forward);
    let change = engine
        .block(
            engine.revision(),
            selected,
            BlockCommand::BulletList,
            &mut ok,
        )
        .unwrap()
        .unwrap();
    assert_eq!(engine.source_text(), expected);
    let comparisons = usize::BITS as usize - lines.leading_zeros() as usize;
    assert!(change.work.link_metadata_items <= lines * (512 + 8 * comparisons));
    let now = total(&change.work);
    assert!(now <= 1_158_673, "{now}");
    engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
    assert_eq!(engine.source_text(), source);
    assert_eq!(engine.selection(), selected);
}
