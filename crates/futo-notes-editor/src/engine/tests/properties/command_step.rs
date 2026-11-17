//! A paragraph key, a toolbar block command, a code block command or a
//! clipboard action at the selection, with properties 3 and 4 checked. A
//! paste, Enter, Shift+Enter and the divider also keep every byte outside
//! their reach (`kept_outside`).
use super::*;

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
fn reach(engine: &Engine, range: DisplayRange) -> std::ops::Range<usize> {
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

/// Every byte outside `reach` survives the command, in order: the command
/// may write between them (marks opened again, a fence lengthened, an
/// escape) but removes none.
fn kept_outside(before: &str, reach: std::ops::Range<usize>, after: &str, name: &str) {
    let mut written = after.chars();
    let kept = before[..reach.start]
        .chars()
        .chain(before[reach.end..].chars())
        .all(|wanted| written.any(|found| found == wanted));
    assert!(
        kept,
        "{name} removed text outside its reach {reach:?}: {before:?} to {after:?}"
    );
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
    let (change, name, writes) = if random.below(6) == 0 {
        // A host's tap on a block's header: selects it as one object.
        let selected = engine.select_code_block(revision, range.start);
        assert_eq!(selected.is_ok(), engine.selected_block().is_some());
        (None, format!("select block at {range:?}"), false)
    } else if random.below(4) == 0 {
        clipboard(engine, range, random)
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
        (
            engine.key(revision, range, key, &mut ok).unwrap(),
            format!("key {key:?} at {range:?}"),
            matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter),
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
        )
    };
    if writes {
        kept_outside(&before.source, reach, &engine.source_text(), &name);
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
