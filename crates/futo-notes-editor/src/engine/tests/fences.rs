//! Fenced code: the literal cases in `tests/fixtures/engine/fences.json`,
//! `code-block-object.json` (a block selected as one object, its edges) and
//! `hidden-line-edges.json` (input over a selection ending at a hidden line).
//!
//! Each case marks the selection in its source with `|` (a caret) or `[`
//! and `]` (`marks` names other characters when the note needs these), runs
//! one command or key (`type:` text typed, `paste:` text pasted, `os:` a
//! text service's replacement of the selection, `commit:` marked text
//! composed over it and committed), and states the source and selection after it. When
//! `typed` is set, that text is typed at the selection first (setup, not
//! checked); `block` selects the block at the selection as one object first.
//! `selected` states whether a block is selected as one object after it,
//! `language` whether the caret writes a block's language, `copied` what
//! copying the selection before it gives, and `error` the refusal it gives.
//! `header:language|name` sets the header of the block at display offset
//! `at` (the selection's start by default); `Select` sends the selection
//! again as a host's echo, `Place` as the user's own. A paste's caret must
//! also be at the marked source offset. Every case that
//! changes the note also undoes to the exact bytes, selection, selected
//! block and language caret, and redoes to the result.
use super::super::Engine;
use super::{ok, range};
use crate::{
    Affinity, BlockCommand, CodeBlockHeader, DisplayOffset, DisplayRange, EditorError, InputAction,
    ParagraphKey,
};

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
    #[serde(default)]
    block: bool,
    #[serde(default)]
    selected: bool,
    #[serde(default)]
    copied: Option<String>,
    #[serde(default)]
    language: bool,
    #[serde(default)]
    at: Option<usize>,
    #[serde(default)]
    error: Option<String>,
}

fn display_selection(engine: &Engine, selection: &std::ops::Range<usize>) -> DisplayRange {
    range(
        engine.display_of(selection.start),
        engine.display_of(selection.end),
    )
}

fn run(engine: &mut Engine, command: &str, at: Option<usize>) -> Result<(), EditorError> {
    let selection = engine.selection();
    let revision = engine.revision();
    let block = |name: &str| match name {
        "CodeBlock" => Some(BlockCommand::CodeBlock),
        "WrapCodeBlock" => Some(BlockCommand::WrapCodeBlock),
        "OpenLineBeforeCodeBlock" => Some(BlockCommand::OpenLineBeforeCodeBlock),
        "OpenLineAfterCodeBlock" => Some(BlockCommand::OpenLineAfterCodeBlock),
        "Indent" => Some(BlockCommand::Indent),
        "Outdent" => Some(BlockCommand::Outdent),
        "Divider" => Some(BlockCommand::Divider),
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
    if let Some(fields) = command.strip_prefix("header:") {
        let (language, name) = fields.split_once('|').expect("header:language|name");
        let header = CodeBlockHeader {
            at: at.map_or(selection.start, DisplayOffset),
            language: language.to_owned(),
            name: name.to_owned(),
        };
        engine.set_code_block_header(revision, &header, &mut ok)?;
    } else if command == "Select" {
        engine.select_with_affinity(revision, selection, engine.affinity())?;
    } else if command == "Place" {
        engine.place_selection(revision, selection, engine.affinity())?;
    } else if let Some(text) = command.strip_prefix("type:") {
        engine
            .replace(revision, selection, text, InputAction::Typing, &mut ok)
            .unwrap();
    } else if let Some(text) = command.strip_prefix("paste:") {
        engine
            .paste_markdown(revision, selection, text, &mut ok)
            .unwrap();
    } else if let Some(text) = command.strip_prefix("os:") {
        engine
            .replace(revision, selection, text, InputAction::Isolated, &mut ok)
            .unwrap();
    } else if let Some(text) = command.strip_prefix("commit:") {
        engine.compose(revision, selection, text)?;
        engine.commit_composition(revision, None, &mut ok).unwrap();
    } else if command == "Cut" {
        engine.cut_markdown(revision, selection, &mut ok).unwrap();
    } else if command == "SelectBlock" {
        engine.select_code_block(revision, selection.start).unwrap();
    } else if let Some(command) = block(command) {
        engine.block(revision, selection, command, &mut ok).unwrap();
    } else if let Some(key) = key(command) {
        engine.key(revision, selection, key, &mut ok).unwrap();
    } else {
        panic!("unknown command {command:?}");
    }
    Ok(())
}

#[test]
fn fence_cases() {
    let mut cases: Vec<Case> =
        serde_json::from_str(include_str!("../../../tests/fixtures/engine/fences.json")).unwrap();
    for objects in [
        include_str!("../../../tests/fixtures/engine/code-block-object.json"),
        include_str!("../../../tests/fixtures/engine/hidden-line-edges.json"),
    ] {
        cases.extend(serde_json::from_str::<Vec<Case>>(objects).unwrap());
    }
    assert!(cases.len() >= 120, "{} cases", cases.len());
    let mut failures = Vec::new();
    for case in &cases {
        let marks: Vec<char> = case.marks.as_deref().unwrap_or("|[]").chars().collect();
        let marks = [marks[0], marks[1], marks[2]];
        let (source, selection) = super::unmark_selection(&case.before, &marks);
        let (want, want_selection) = super::unmark_selection(&case.after, &marks);
        let mut engine = Engine::open(&source);
        super::select_source_range(&mut engine, selection.clone());
        if let Some(text) = &case.typed {
            let at = engine.selection();
            engine
                .replace(engine.revision(), at, text, InputAction::Typing, &mut ok)
                .unwrap();
        }
        if case.block {
            let at = engine.selection().start;
            engine.select_code_block(engine.revision(), at).unwrap();
        }
        if let Some(want) = &case.copied {
            let copied = engine.copy_markdown(engine.revision(), engine.selection());
            if copied.as_ref() != Ok(want) {
                failures.push(format!("{}: copied {copied:?}", case.name));
            }
        }
        let opening = engine.source_text();
        let opening_selection = engine.selection();
        let opening_block = engine.selected_block();
        let opening_language = engine.writes_language();
        let groups = engine.history.undo.len();
        let error = run(&mut engine, &case.command, case.at)
            .err()
            .map(|error| format!("{error:?}"));
        if error != case.error {
            failures.push(format!("{}: error {error:?}", case.name));
        }
        let got = engine.source_text();
        let got_selection = engine.selection();
        let got_block = engine.selected_block();
        let got_language = engine.writes_language();
        let fresh = Engine::open(&got);
        if engine.selected_block().is_some() != case.selected || got_language != case.language {
            failures.push(format!(
                "{}: selected block {:?}, language {got_language}",
                case.name,
                engine.selected_block()
            ));
        }
        // A paste's caret is also checked in source: the end of a pasted
        // block and the start of the line after it show at one offset.
        let got_caret = engine.source_selection(got_selection);
        let caret_differs = case.command.starts_with("paste:")
            && want_selection.is_empty()
            && got_caret != want_selection;
        if got != want
            || got_selection != display_selection(&fresh, &want_selection)
            || caret_differs
        {
            failures.push(format!(
                "{}: got {got:?} selection {got_selection:?} caret {got_caret:?}, want {want:?} selection {:?}",
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
        if engine.source_text() != opening
            || engine.selection() != opening_selection
            || engine.selected_block() != opening_block
            || engine.writes_language() != opening_language
        {
            failures.push(format!(
                "{}: undo gave {:?} {:?}",
                case.name,
                engine.source_text(),
                engine.selection()
            ));
            continue;
        }
        engine.redo(engine.revision(), &mut ok).unwrap().unwrap();
        if engine.source_text() != want
            || engine.selection() != got_selection
            || engine.selected_block() != got_block
            || engine.writes_language() != got_language
        {
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
fn a_selected_block_ends_with_another_selection_and_composes_whole() {
    let mut engine = Engine::open("a\n```\nx\n```\nb");
    let selected = engine.select_code_block(engine.revision(), crate::DisplayOffset(2));
    let block = Some(range(2, 3));
    assert_eq!(selected.unwrap().selected_block, block);
    let echo = engine.select_with_affinity(engine.revision(), range(2, 3), Affinity::Forward);
    assert_eq!(echo.unwrap().selected_block, block);
    let moved = engine.select(engine.revision(), range(2, 2)).unwrap();
    assert_eq!(moved.selected_block, None);
    engine
        .select_code_block(engine.revision(), crate::DisplayOffset(3))
        .unwrap();
    engine
        .compose(engine.revision(), range(2, 3), "か")
        .unwrap();
    let committed = engine
        .commit_view(engine.revision(), None, &mut ok)
        .unwrap();
    assert_eq!(committed.unwrap().selected_block, None);
    assert_eq!(engine.source_text(), "a\nか\nb");
    assert!(engine
        .select_code_block(engine.revision(), crate::DisplayOffset(0))
        .is_err());
}

#[test]
fn a_header_change_reports_its_block_with_the_new_header() {
    let mut engine = Engine::open("a\n```js hl:1\nx\n```\nb");
    let header = CodeBlockHeader {
        at: DisplayOffset(2),
        language: "go".into(),
        name: "main.go".into(),
    };
    let change = engine
        .set_code_block_header(engine.revision(), &header, &mut ok)
        .unwrap()
        .unwrap();
    let block = &change.projection.code_blocks[0];
    assert_eq!(block.range, range(2, 3));
    assert_eq!(block.language.as_deref(), Some("go"));
    assert_eq!(block.name.as_deref(), Some("main.go"));
    assert_eq!(change.selection, range(0, 0));
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
