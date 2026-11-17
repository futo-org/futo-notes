//! Keys inside a fence, and the Indent and Outdent buttons on code.
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::{leading, Touch};
use crate::{DisplayRange, EditorError, ParagraphKey};

/// What Outdent and Shift+Tab take off the start of a code line: a tab, else
/// up to two spaces.
fn outdent_width(text: &str) -> usize {
    if text.starts_with('\t') {
        1
    } else {
        text.bytes().take(2).take_while(|&b| b == b' ').count()
    }
}

impl Engine {
    /// Keys on code: on a selected block (`selected.rs`), at a block's
    /// edges (`edges.rs`), and inside a fence: Enter and Shift+Enter, Tab and
    /// Shift+Tab.
    pub(in super::super) fn fence_key(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        if let Some(command) = self
            .selected_block_key(range, key)
            .or_else(|| self.block_edge_key(range, key))
        {
            return Ok(Some(command));
        }
        match key {
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => Ok(match self.touch(range) {
                Some(Touch::Code(lines)) => Some(
                    self.emptied_block(range)
                        .unwrap_or_else(|| self.code_break(range, lines.start)),
                ),
                _ => None,
            }),
            ParagraphKey::Tab | ParagraphKey::ShiftTab => Ok(self
                .touch(range)
                .map(|touch| self.code_indent(range, touch, key == ParagraphKey::ShiftTab, true))),
            ParagraphKey::Backspace
            | ParagraphKey::BackspaceJoiningHeading
            | ParagraphKey::Delete
            | ParagraphKey::Transpose => Ok(None),
        }
    }

    /// The Indent and Outdent buttons on code: `None` when the range is not
    /// in code (the list family's), else the command (which may change
    /// nothing).
    pub(in super::super) fn fence_indent(
        &self,
        range: DisplayRange,
        outdent: bool,
    ) -> Result<Option<Command>, EditorError> {
        Ok(self
            .touch(range)
            .map(|touch| self.code_indent(range, touch, outdent, false)))
    }

    /// Whether Indent and Outdent can act on the selection, when it is in
    /// code.
    pub(crate) fn code_indent_state(&self) -> Option<(bool, bool)> {
        Some(match self.touch(self.selection)? {
            Touch::Empty(_) => (true, false),
            Touch::Code(lines) => (
                true,
                lines
                    .into_iter()
                    .any(|index| outdent_width(self.line(index).body()) > 0),
            ),
        })
    }

    /// Enter in code: a line break in the line's own spelling, then the
    /// code line's leading whitespace up to the caret. It lands as typing
    /// does (no guard): the text is code.
    fn code_break(&self, range: DisplayRange, line: usize) -> Command {
        let selection = self.source_selection(range);
        let start = self.line_start(line);
        let indent = leading(self.line(line).body());
        let indent = &indent[..indent.len().min(selection.start - start)];
        let text = format!("{}{indent}", self.new_ending(line));
        let plan = self.plan(range, &text);
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        let mut command = Command::new(
            vec![Edit::new(plan.range, plan.inserted)],
            first..last + 1,
            plan.caret..plan.caret,
        );
        command.typed = true;
        command
    }

    /// Tab and Shift+Tab (`key`), Indent and Outdent on code. Tab writes two
    /// spaces at a caret, or at the start of each selected line; Indent
    /// writes a tab at the start of each touched line. Shift+Tab and Outdent
    /// take a tab, else up to two spaces, off each touched line.
    fn code_indent(&self, range: DisplayRange, touch: Touch, outdent: bool, key: bool) -> Command {
        let unit = if key { "  " } else { "\t" };
        let lines = match &touch {
            Touch::Code(lines) => lines.clone(),
            Touch::Empty(open) => *open..open + 1,
        };
        let collapsed = range.start == range.end;
        if let (Touch::Empty(open), false) = (&touch, outdent) {
            // An empty block's line, even selected as one object: written.
            let at = self.line_start(*open) + self.line(*open).body_len();
            let caret = at + self.new_ending(*open).len() + unit.len();
            let text = format!("{}{unit}", self.new_ending(*open));
            return Command::new(vec![Edit::insert(at, text)], *open..open + 1, caret..caret);
        }
        if !outdent && collapsed && key {
            // At the caret.
            let plan = self.plan(range, unit);
            let line = self.line_of(plan.range.start);
            return Command::new(
                vec![Edit::new(plan.range, plan.inserted)],
                line..line + 1,
                plan.caret..plan.caret,
            );
        }
        let mut edits = Vec::new();
        if !matches!(touch, Touch::Empty(_)) {
            for index in lines.clone() {
                let start = self.line_start(index);
                if outdent {
                    let width = outdent_width(self.line(index).body());
                    if width > 0 {
                        edits.push(Edit::new(start..start + width, ""));
                    }
                } else {
                    edits.push(Edit::insert(start, unit));
                }
            }
        }
        let selection = self.source_selection(range);
        let mut command = Command::new(edits, lines, 0..0);
        command.selection = command.map(selection.start, true)..command.map(selection.end, true);
        command
    }
}
