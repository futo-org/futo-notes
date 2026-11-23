//! Random edits on notes dense with fences and tables, where a host that
//! applies each change's projection must hold what a fresh projection
//! reports (`BlockMirror`), and every table's facts equal inspection's
//! (`check_table_facts`): fence and table lines typed, pasted and deleted,
//! info strings and delimiter rows edited, adjacent blocks, the code block
//! command, the keys at a block's edges, and table commands and keys, between
//! the five properties' own steps.
use super::super::tables::projection::check_table_facts;
use super::block_mirror::BlockMirror;
use super::*;
use std::ops::Range;

const FENCE_NOTE_LINES: &[&str] = &[
    "```",
    "```",
    "```",
    "```js",
    "```py name:a hl:1",
    "~~~",
    "````",
    "```q",
    "  ```",
    "\\```",
    "code",
    "x",
    "y z",
    "",
    "- a",
    "# h",
    "> q",
    "| a | b |",
    "| a |",
    "|---|---|",
    "|:-:|",
    "| x | y | z |",
    "| p \\| q |",
];

const FENCE_LINES: &[&str] = &[
    "```\n",
    "```js\n",
    "~~~\n",
    "```py\n",
    "````\n",
    "```\n```\n",
    "| a | b |\n",
    "|---|\n",
    "|:--|--:|\n",
    "| c |\n",
];

const INFO: &[&str] = &["js", " name:x", "y", " hl:2", "`", "~", "|", ":", " d |"];

fn fenced_note(random: &mut Random) -> String {
    let lines: Vec<&str> = (0..random.below(14))
        .map(|_| random.pick(FENCE_NOTE_LINES))
        .collect();
    let ending = if random.below(5) == 0 { "\r\n" } else { "\n" };
    lines.join(ending)
}

/// Source ranges of the note's lines, each with its ending.
fn source_lines(source: &str) -> Vec<Range<usize>> {
    let mut start = 0;
    let mut lines: Vec<Range<usize>> = source
        .split_inclusive('\n')
        .map(|line| {
            start += line.len();
            start - line.len()..start
        })
        .collect();
    if source.is_empty() || source.ends_with('\n') {
        lines.push(source.len()..source.len());
    }
    lines
}

/// A source edit at a random line: a fence line put before it, the line
/// deleted, or its info string (the text before its ending) grown or cut.
fn fence_source_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    let source = engine.source_text();
    let lines = source_lines(&source);
    let line = lines[random.below(lines.len())].clone();
    let body_end = line.start + source[line.clone()].trim_end_matches(['\r', '\n']).len();
    let (range, text) = match random.below(4) {
        0 => (line.start..line.start, random.pick(FENCE_LINES)),
        1 => (line.clone(), ""),
        2 if body_end > line.start => {
            let mut cut = body_end - 1;
            while !source.is_char_boundary(cut) {
                cut -= 1;
            }
            (cut..body_end, "")
        }
        _ => (body_end..body_end, random.pick(INFO)),
    };
    let before = state(engine);
    let groups = engine.history.undo.len();
    let range = SourceRange {
        start: SourceOffset(range.start),
        end: SourceOffset(range.end),
    };
    let revision = engine.revision();
    if let Some(change) = engine.edit_source(revision, range, text, &mut ok).unwrap() {
        apply_view(view, &change);
        model.edited(engine, before, groups);
    }
    format!("edit source {range:?} to {text:?}")
}

/// Enter, Backspace or Delete at the start or end of a random shown line.
fn edge_key_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    use crate::ParagraphKey;
    let display = engine.display_text();
    let mut edges = vec![0, display.len()];
    for (at, _) in display.match_indices('\n') {
        let before_break = if display[..at].ends_with('\r') {
            at - 1
        } else {
            at
        };
        edges.extend([before_break, at + 1]);
    }
    let at = edges[random.below(edges.len())];
    let caret = DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    };
    let revision = engine.revision();
    engine
        .select_with_affinity(revision, caret, Affinity::Forward)
        .unwrap();
    let key = [
        ParagraphKey::Enter,
        ParagraphKey::ShiftEnter,
        ParagraphKey::Backspace,
        ParagraphKey::Delete,
    ][random.below(4)];
    let before = state(engine);
    let groups = engine.history.undo.len();
    let selection = engine.selection();
    let change = engine.key(revision, selection, key, &mut ok).unwrap();
    if let Some(change) = change.filter(|change| change.revision != revision) {
        apply_view_change(view, &change);
        model.edited(engine, before, groups);
    }
    format!("key {key:?} at {at}")
}

/// A table command at a random display offset, or a paragraph key the
/// table claims there (Tab appends a row past the last cell, Enter below
/// the last row).
fn table_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    use crate::{ParagraphKey, TableCommand};
    let display = engine.display_text();
    let mut stops: Vec<usize> = display.char_indices().map(|(at, _)| at).collect();
    stops.push(display.len());
    let at = stops[random.below(stops.len())];
    let caret = DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    };
    let revision = engine.revision();
    engine
        .select_with_affinity(revision, caret, Affinity::Forward)
        .unwrap();
    let before = state(engine);
    let groups = engine.history.undo.len();
    let (change, name) = if random.below(2) == 0 {
        let command = [
            TableCommand::InsertRowAbove,
            TableCommand::InsertRowBelow,
            TableCommand::DeleteRow,
            TableCommand::InsertColumnLeft,
            TableCommand::InsertColumnRight,
            TableCommand::DeleteColumn,
        ][random.below(6)];
        let change = engine.run_table_command(revision, caret, command, &mut ok);
        (change.unwrap(), format!("table {command:?} at {at}"))
    } else {
        let key = [ParagraphKey::Tab, ParagraphKey::Enter][random.below(2)];
        let change = engine.key(revision, caret, key, &mut ok).unwrap();
        (change, format!("key {key:?} at {at}"))
    };
    if let Some(change) = change.filter(|change| change.revision != revision) {
        apply_view_change(view, &change);
        model.edited(engine, before, groups);
    }
    name
}

#[test]
fn a_host_applying_each_change_holds_what_a_fresh_projection_reports() {
    let mut random = Random::from_env();
    let mut checked = 0;
    for case in 0..cases() {
        let original = fenced_note(&mut random);
        let mut engine = Engine::open(&original);
        let mut mirror = BlockMirror::open(&engine);
        let mut model = Model::default();
        let mut view = View::new(engine.display_text());
        let mut steps = Vec::new();
        for _ in 0..24 {
            let done = match random.below(5) {
                0 => fence_source_step(&mut engine, &mut model, &mut view, &mut random),
                1 => edge_key_step(&mut engine, &mut model, &mut view, &mut random),
                2 => table_step(&mut engine, &mut model, &mut view, &mut random),
                _ => step(&mut engine, &mut model, &mut view, &mut random),
            };
            steps.push(done);
            let context = format!(
                "case {case} from {original:?} after {steps:?}, now {:?}",
                engine.source_text()
            );
            assert_eq!(view.text, engine.display_text(), "view change {context}");
            view.restyled.clear();
            mirror.check(&engine, &mut view, &context);
            check_table_facts(&engine, &context);
        }
        checked += mirror.checked;
    }
    assert!(checked > cases() * 12, "only {checked} changes checked");
}
