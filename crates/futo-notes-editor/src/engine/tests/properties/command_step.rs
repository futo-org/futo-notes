//! A paragraph key, a toolbar block command, a code block command or a
//! clipboard action at the selection, with properties 3 and 4 checked.
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

/// Paste a random text, or cut, at `range`.
fn clipboard(
    engine: &mut Engine,
    range: DisplayRange,
    random: &mut Random,
) -> (Option<crate::ViewChange>, String) {
    let revision = engine.revision();
    if random.below(4) == 0 {
        let (_, change) = engine.cut_markdown(revision, range, &mut ok).unwrap();
        return (change, format!("cut {range:?}"));
    }
    let text = random.pick(PASTED);
    let change = match engine.paste_markdown(revision, range, text, &mut ok) {
        // A paste across table cells is refused and changes nothing.
        Err(crate::EditorError::UnrepresentableFormat) => None,
        change => change.unwrap(),
    };
    (change, format!("paste {text:?} at {range:?}"))
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
    let (change, name) = if random.below(6) == 0 {
        // A host's tap on a block's header: selects it as one object.
        let selected = engine.select_code_block(revision, range.start);
        assert_eq!(selected.is_ok(), engine.selected_block().is_some());
        (None, format!("select block at {range:?}"))
    } else if random.below(4) == 0 {
        clipboard(engine, range, random)
    } else if random.below(2) == 0 {
        let key = [
            ParagraphKey::Enter,
            ParagraphKey::ShiftEnter,
            ParagraphKey::Backspace,
            ParagraphKey::BackspaceJoiningHeading,
            ParagraphKey::Delete,
            ParagraphKey::Tab,
            ParagraphKey::ShiftTab,
        ][random.below(7)];
        (
            engine.key(revision, range, key, &mut ok).unwrap(),
            format!("key {key:?} at {range:?}"),
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
        )
    };
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
