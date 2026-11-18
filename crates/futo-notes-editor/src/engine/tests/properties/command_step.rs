//! A paragraph key, a toolbar block command, a code block command or a
//! clipboard action at the selection, with properties 3 and 4 checked. A
//! paste, Enter, Shift+Enter and the divider also keep every byte outside
//! their reach (`kept_outside`), besides what Enter rewrites in a list
//! (`enter_rewrites.rs`).
use super::enter_rewrites::enter_rewrites;
use super::*;
use std::ops::Range;

/// Pasted texts: lines, blocks, fences, table syntax and line endings.
const PASTED: &[&str] = &[
    "x",
    "a b\n",
    "x\ny",
    "\t\r\n",
    "- a\n  - b",
    "# h\n>\nz",
    "> q\n> r",
    "```\ncode",
    "~~~\nx\n~~~",
    "|---|---|",
    "| a | b |\r\n| c |",
    "1. one\r\n2) two",
    "**b** [l](u)\n*i",
    "---",
];

/// The source a command writing at display `range` may rewrite: its reach
/// (`plan_cleared`, which takes the code blocks `block_reach` takes) from
/// the start of the line it starts on, through that line's marker when the
/// reach starts before its content (a pasted block takes the caret line's
/// quote, list or heading marker, indent or blank line's whitespace; a
/// divider's or fence's text is no marker).
fn reach(engine: &Engine, range: DisplayRange) -> Range<usize> {
    let plan = engine.plan_cleared(engine.outside_crlf(range));
    let first = engine.line_of(plan.range.start);
    let start = engine.line_start(first);
    let line = &engine.line(first).line;
    let marker = match line.kind {
        Kind::Divider | Kind::Fence { .. } => 0,
        _ => line.content.start,
    };
    start..plan.range.end.max(start + marker)
}

/// What a command may rewrite: its reach, and what Enter rewrites besides
/// it (`enter_rewrites`).
struct Rewritten {
    reach: Range<usize>,
    besides: Vec<Range<usize>>,
}

/// Whether every byte of `before` outside what the command may rewrite
/// survives in `after`, in order: the command may write between them (marks
/// opened again, a fence lengthened, an escape, a bumped number) but removes
/// none.
fn kept_outside(rewritten: &Rewritten, before: &str, after: &str) -> bool {
    let mut written = after.chars();
    before
        .char_indices()
        .filter(|(at, _)| {
            !rewritten.reach.contains(at)
                && !rewritten.besides.iter().any(|range| range.contains(at))
        })
        .all(|(_, wanted)| written.any(|found| found == wanted))
}

/// Paste a random text, or cut, at `range`; whether it pasted.
fn clipboard(
    engine: &mut Engine,
    range: DisplayRange,
    random: &mut Random,
) -> (Option<crate::ViewChange>, String, bool) {
    let revision = engine.revision();
    if random.below(4) == 0 {
        let (_, change) = engine.cut_markdown(revision, range, &mut ok).unwrap();
        return (change, format!("cut {range:?}"), false);
    }
    let text = random.pick(PASTED);
    let change = match engine.paste_markdown(revision, range, text, &mut ok) {
        // A paste across table cells is refused and changes nothing.
        Err(crate::EditorError::UnrepresentableFormat) => None,
        change => change.unwrap(),
    };
    (change, format!("paste {text:?} at {range:?}"), true)
}

/// A paragraph key or toolbar block command at the selection, through the
/// command families and the guard. Properties 3 and 4 hold for commands as
/// for typing; a cancelled command changes nothing.
pub(super) fn command_step(
    engine: &mut Engine,
    model: &mut Model,
    view: &mut View,
    random: &mut Random,
) -> String {
    use crate::{BlockCommand, ParagraphKey};
    let revision = engine.revision();
    let before = state(engine);
    let groups = engine.history.undo.len();
    let range = engine.selection();
    let reach = reach(engine, range);
    let enter_besides = enter_rewrites(engine, &reach);
    let (change, name, writes, enter) = if random.below(6) == 0 {
        // A host's tap on a block's header: selects it as one object.
        let selected = engine.select_code_block(revision, range.start);
        assert_eq!(selected.is_ok(), engine.selected_block().is_some());
        (None, format!("select block at {range:?}"), false, false)
    } else if random.below(4) == 0 {
        let (change, name, pasted) = clipboard(engine, range, random);
        (change, name, pasted, false)
    } else if random.below(2) == 0 {
        let key = [
            ParagraphKey::Enter,
            ParagraphKey::ShiftEnter,
            ParagraphKey::Backspace,
            ParagraphKey::BackspaceJoiningHeading,
            ParagraphKey::PairedBackspace,
            ParagraphKey::Delete,
            ParagraphKey::Tab,
            ParagraphKey::ShiftTab,
        ][random.below(8)];
        let enter = matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter);
        (
            engine.key(revision, range, key, &mut ok).unwrap(),
            format!("key {key:?} at {range:?}"),
            enter,
            enter,
        )
    } else {
        let level = random.below(7) as u8;
        let command = [
            BlockCommand::Heading(level),
            BlockCommand::ToggleHeading(level.max(1)),
            BlockCommand::Quote,
            BlockCommand::Indent,
            BlockCommand::Outdent,
            BlockCommand::Divider,
            BlockCommand::ToggleTask,
            BlockCommand::BulletList,
            BlockCommand::OrderedList,
            BlockCommand::TaskList,
            BlockCommand::CodeBlock,
            BlockCommand::WrapCodeBlock,
            BlockCommand::OpenLineBeforeCodeBlock,
            BlockCommand::OpenLineAfterCodeBlock,
        ][random.below(14)];
        (
            engine.block(revision, range, command, &mut ok).unwrap(),
            format!("command {command:?} at {range:?}"),
            command == BlockCommand::Divider,
            false,
        )
    };
    if writes {
        let rewritten = Rewritten {
            reach,
            besides: if enter { enter_besides } else { Vec::new() },
        };
        let after = engine.source_text();
        assert!(
            kept_outside(&rewritten, &before.source, &after),
            "{name} removed text outside its reach {:?} and {:?}: {:?} to {after:?}",
            rewritten.reach,
            rewritten.besides,
            before.source
        );
    }
    match change {
        // A table key that only moves the selection.
        Some(change) if change.revision == revision => {
            assert!(change.inserted.is_empty(), "{name} moved only");
            assert_eq!(engine.source_text(), before.source, "{name} moved only");
            assert_eq!(engine.history.undo.len(), groups, "{name} moved only");
        }
        Some(change) => {
            apply_view_change(view, &change);
            assert_eq!(change.revision, engine.revision(), "{name}");
            model.edited(engine, before, groups);
        }
        None => {
            assert_eq!(engine.revision(), revision, "{name} changed nothing");
            assert_eq!(
                engine.source_text(),
                before.source,
                "{name} changed nothing"
            );
        }
    }
    name
}
