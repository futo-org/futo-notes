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

mod work;

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
pub(super) fn select_source(engine: &mut Engine, selected: Range<usize>) {
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
        include_str!("../../../tests/fixtures/engine/lists/marker.json"),
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

/// A host points the checkbox toggle at the clicked task's line; the
/// selection elsewhere stays, through Undo and Redo.
#[test]
fn the_checkbox_toggle_keeps_the_selection_on_another_line() {
    let source = "- [ ] a\n**b** c";
    let after_b = Engine::open(source).display_text().find(" c").unwrap();
    for (start, end, affinity) in [
        (after_b, after_b, Affinity::Backward),
        (after_b, after_b, Affinity::Forward),
        (after_b - 1, after_b + 2, Affinity::Forward),
    ] {
        let mut engine = Engine::open(source);
        super::select(&mut engine, start, end, affinity);
        let kept = (engine.selection(), engine.affinity(), engine.caret_source());
        let toggled = engine
            .block(
                engine.revision(),
                range(0, 0),
                BlockCommand::ToggleTask,
                &mut ok,
            )
            .unwrap()
            .unwrap();
        assert_eq!(engine.source_text(), "- [x] a\n**b** c");
        let now = |engine: &Engine| (engine.selection(), engine.affinity(), engine.caret_source());
        assert_eq!(now(&engine), kept, "after the toggle, {affinity:?}");
        assert_eq!((toggled.selection, toggled.affinity), (kept.0, kept.1));
        engine.undo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(now(&engine), kept, "after Undo, {affinity:?}");
        engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
        assert_eq!(now(&engine), kept, "after Redo, {affinity:?}");
    }
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
        ("- a\n\t- b", 5, (true, true)),
        ("- a\n  - [ ] b", 5, (true, true)),
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
