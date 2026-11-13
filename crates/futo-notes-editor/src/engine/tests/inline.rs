//! Inline formatting and links: the literal cases in
//! `tests/fixtures/engine/inline.json` and `links.json`, and the work a
//! select-all toggle costs.
//!
//! A case's `before` and `after` are note text with the selection marked:
//! `⟦` and `⟧` around a selection, `‸` at a caret (the link and table
//! syntax under test uses `[`, `]` and `|`). Where hidden marks surround a
//! marker, any place that shows at the same display offset is the same
//! selection. `command` is a list of steps; `error` names the error the
//! last step returns, the note unchanged; `formats` is what the toolbar
//! lights afterwards. Every case also undoes back to its exact bytes, and
//! redoes to its result.
use super::super::Engine;
use super::ok;
use crate::{
    Affinity, DisplayOffset, DisplayRange, EditorError, InlineFormat, InputAction, ParagraphKey,
};
use serde_json::Value;

/// `text` without its selection markers, and the selection's source range.
fn marked(text: &str) -> (String, usize, usize) {
    let mut source = String::new();
    let (mut start, mut end) = (None, None);
    for ch in text.chars() {
        match ch {
            '⟦' => start = Some(source.len()),
            '⟧' => end = Some(source.len()),
            '‸' => {
                start = Some(source.len());
                end = start;
            }
            _ => source.push(ch),
        }
    }
    let start = start.unwrap_or_else(|| panic!("no selection in {text:?}"));
    (source, start, end.unwrap_or(start))
}

fn display(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

/// The display selection of source `start..end`, and a caret's affinity:
/// the side of the hidden marks its source offset is on.
fn selection_of(engine: &Engine, start: usize, end: usize) -> (DisplayRange, Affinity) {
    let range = display(engine.display_of(start), engine.display_of(end));
    let (lo, hi) = engine.source_bounds(range.start.0);
    let affinity = if start == hi && hi != lo {
        Affinity::Forward
    } else {
        Affinity::Backward
    };
    (range, affinity)
}

fn format(name: &str) -> Option<InlineFormat> {
    Some(match name {
        "bold" => InlineFormat::Bold,
        "italic" => InlineFormat::Italic,
        "strike" => InlineFormat::Strike,
        "code" => InlineFormat::Code,
        _ => return None,
    })
}

fn text(step: &[Value], at: usize) -> &str {
    step[at].as_str().expect("a text argument")
}

fn number(step: &[Value], at: usize) -> usize {
    step[at].as_u64().expect("a number argument") as usize
}

/// Run one step; whether it was an action that can be undone.
fn run(engine: &mut Engine, step: &[Value]) -> Result<(), EditorError> {
    let name = text(step, 0);
    let revision = engine.revision();
    let selection = engine.selection();
    if let Some(format) = format(name) {
        engine.toggle_format_view(revision, format, &mut ok)?;
        return Ok(());
    }
    match name {
        "type" => {
            engine.replace(
                revision,
                selection,
                text(step, 1),
                InputAction::Typing,
                &mut ok,
            )?;
        }
        "select" => {
            let range = display(number(step, 1), number(step, 2));
            engine.select(revision, range)?;
        }
        "replace" => {
            let range = display(number(step, 1), number(step, 2));
            engine.replace(
                revision,
                range,
                text(step, 3),
                InputAction::Isolated,
                &mut ok,
            )?;
        }
        "type_at" => {
            // A host's keystroke at a caret other than the selection.
            let at = number(step, 1);
            engine.replace(
                revision,
                display(at, at),
                text(step, 2),
                InputAction::Typing,
                &mut ok,
            )?;
        }
        "replace_word" => {
            let caret = selection.start.0;
            let range = display(caret - number(step, 1), caret);
            engine.replace(
                revision,
                range,
                text(step, 2),
                InputAction::Isolated,
                &mut ok,
            )?;
        }
        "link" => {
            engine.set_link_view(revision, selection, text(step, 1), &mut ok)?;
        }
        "edit_link" => {
            engine.edit_link_view(revision, selection, text(step, 1), text(step, 2), &mut ok)?;
        }
        "key" => {
            let key = match text(step, 1) {
                "enter" => ParagraphKey::Enter,
                "backspace" => ParagraphKey::Backspace,
                "delete" => ParagraphKey::Delete,
                other => panic!("unknown key {other:?}"),
            };
            engine.key(revision, selection, key, &mut ok)?;
        }
        other => panic!("unknown step {other:?}"),
    }
    Ok(())
}

fn error_name(error: &EditorError) -> String {
    format!("{error:?}")
}

#[test]
fn the_inline_cases_hold() {
    let cases: Vec<Value> = [
        include_str!("../../../tests/fixtures/engine/inline.json"),
        include_str!("../../../tests/fixtures/engine/links.json"),
    ]
    .into_iter()
    .flat_map(|text| serde_json::from_str::<Vec<Value>>(text).unwrap())
    .collect();
    let mut failures = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let result = std::panic::catch_unwind(|| check(case));
        if let Err(panic) = result {
            let message = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            failures.push(format!("{name}: {message}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases failed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

fn check(case: &Value) {
    let (source, start, end) = marked(case["before"].as_str().unwrap());
    let mut engine = Engine::open(&source);
    let (opening, affinity) = selection_of(&engine, start, end);
    engine
        .select_with_affinity(engine.revision(), opening, affinity)
        .unwrap();
    let opening = engine.selection();
    let steps = case["command"].as_array().unwrap();
    let last = steps.len() - 1;
    for (index, step) in steps.iter().enumerate() {
        let step = step.as_array().unwrap();
        match run(&mut engine, step) {
            Ok(()) => {}
            Err(error) if index == last && case.get("error").is_some() => {
                assert_eq!(error_name(&error), case["error"].as_str().unwrap());
                assert_eq!(engine.source_text(), source, "an error changes nothing");
                assert_eq!(engine.selection(), opening);
                return;
            }
            Err(error) => panic!("step {step:?} failed: {error:?}"),
        }
    }
    assert!(
        case.get("error").is_none(),
        "expected an error, got {:?}",
        engine.source_text()
    );
    let (want, start, end) = marked(case["after"].as_str().unwrap());
    assert_eq!(engine.source_text(), want, "source");
    let fresh = Engine::open(&want);
    assert_eq!(engine.display_text(), fresh.display_text(), "display");
    let (selection, _) = selection_of(&fresh, start, end);
    assert_eq!(engine.selection(), selection, "selection");
    if let Some(formats) = case.get("formats") {
        let want: Vec<InlineFormat> = formats
            .as_array()
            .unwrap()
            .iter()
            .map(|name| format(&name.as_str().unwrap().to_lowercase()).unwrap())
            .collect();
        assert_eq!(engine.toolbar().formats, want, "toolbar formats");
    }
    // Undo back to the exact bytes; a one-step command also restores the
    // selection, and redo writes the result again.
    let mut undone = 0;
    while engine.undo(engine.revision(), &mut ok).unwrap().is_some() {
        undone += 1;
    }
    assert_eq!(engine.source_text(), source, "undo");
    if undone == 0 {
        return;
    }
    if steps.len() == 1 {
        assert_eq!(engine.selection(), opening, "undo selection");
    }
    while engine.redo(engine.revision(), &mut ok).unwrap().is_some() {}
    assert_eq!(engine.source_text(), want, "redo");
}

#[test]
fn inline_commands_apply_where_a_line_holds_inline_text() {
    for (source, start, end, allowed) in [
        ("plain", 0, 0, true),
        ("", 0, 0, true),
        ("```\ncode\n```", 1, 1, false),
        ("plain\n\n```\ncode\n```", 0, 11, true),
        ("plain\n\n```\ncode\n```", 7, 11, false),
        ("| a |\n|---|\n| b |", 1, 1, true),
        ("---\nkey: v\n---\nbody", 7, 7, true),
    ] {
        let mut engine = Engine::open(source);
        engine
            .select(engine.revision(), display(start, end))
            .unwrap();
        assert_eq!(
            engine.toolbar().inline_allowed,
            allowed,
            "{source:?} {start}..{end}"
        );
    }
}

/// The old engine's work for the same scenarios (measured on the old engine
/// at e995de29e): `tests/inline/multi_block.rs`
/// `a_select_all_toggle_costs_work_linear_in_the_note` and
/// `tests/inline/work.rs`. The core may not do more.
#[test]
fn a_select_all_toggle_costs_no_more_work_than_the_old_engine() {
    // (sections, materialized, parsed, metadata items) on the old engine.
    let old = [
        (250, 69_664, 26_559, 203_797),
        (1_000, 282_664, 107_559, 883_613),
    ];
    let mut per_section = Vec::new();
    for (count, materialized, parsed, items) in old {
        let source: String = (0..count)
            .map(|i| format!("## Section {i}\n\nBody line {i} with **bold**.\n\n"))
            .collect();
        let mut engine = Engine::open(&source);
        let all = display(0, engine.display_len());
        engine.select(engine.revision(), all).unwrap();
        let change = engine
            .toggle_format_view(engine.revision(), InlineFormat::Bold, &mut ok)
            .unwrap()
            .unwrap();
        assert!(engine
            .source_text()
            .starts_with("## **Section 0**\n\n**Body line 0 with bold.**"));
        let work = change.work;
        eprintln!("select-all bold, {count} sections: {work:?}");
        assert!(work.materialized_source_bytes <= materialized, "{work:?}");
        assert!(work.parsed_source_bytes <= parsed, "{work:?}");
        assert!(work.link_metadata_items <= items, "{work:?}");
        per_section.push([
            work.parsed_source_bytes / count,
            work.materialized_source_bytes / count,
            work.link_metadata_items / count,
        ]);
    }
    for (small, large) in per_section[0].iter().zip(&per_section[1]) {
        assert!(*large <= small + small / 2, "per section: {per_section:?}");
    }
}

#[test]
fn typing_far_into_a_long_note_costs_no_more_work_than_the_old_engine() {
    // (paragraphs, materialized, parsed, metadata items) on the old engine.
    let old = [(20, 49, 40, 501), (20_000, 49, 40, 602)];
    let mut measured = Vec::new();
    for (count, materialized, parsed, items) in old {
        let text = "__word__ rest\r\n\r\n".repeat(count);
        let mut engine = Engine::open(&text);
        let at = (count - 2) * "word rest\r\n\r\n".len() + 2;
        engine.select(engine.revision(), display(at, at)).unwrap();
        let change = engine
            .input(
                engine.revision(),
                display(at, at),
                "x",
                InputAction::Typing,
                &mut ok,
            )
            .unwrap();
        assert_eq!(change.selection, display(at + 1, at + 1));
        let work = change.work;
        eprintln!("typing, {count} paragraphs: {work:?}");
        assert!(work.materialized_source_bytes <= materialized, "{work:?}");
        assert!(work.parsed_source_bytes <= parsed, "{work:?}");
        assert!(work.link_metadata_items <= items, "{work:?}");
        measured.push(work);
    }
    assert_eq!(
        measured[0], measured[1],
        "the work does not grow with the note"
    );
}

/// Decision 5: undo and redo restore the formats a deletion left carried.
#[test]
fn history_restores_the_formats_a_cleared_span_left_carried() {
    let mut engine = Engine::open("a **Owner** b");
    engine.select(engine.revision(), display(2, 7)).unwrap();
    assert_eq!(engine.active_formats(), vec![InlineFormat::Bold]);
    engine
        .key(
            engine.revision(),
            display(2, 7),
            ParagraphKey::Backspace,
            &mut ok,
        )
        .unwrap();
    assert_eq!(engine.source_text(), "a  b");
    assert_eq!(engine.formats, Some(vec![InlineFormat::Bold]));
    engine.undo(engine.revision(), &mut ok).unwrap();
    assert_eq!(engine.source_text(), "a **Owner** b");
    assert_eq!(engine.selection(), display(2, 7));
    assert_eq!(engine.formats, None);
    engine.redo(engine.revision(), &mut ok).unwrap();
    assert_eq!(engine.selection(), display(2, 2));
    assert_eq!(engine.formats, Some(vec![InlineFormat::Bold]));
    let at = engine.selection();
    engine
        .replace(engine.revision(), at, "x", InputAction::Typing, &mut ok)
        .unwrap();
    assert_eq!(engine.source_text(), "a **x** b");
}
