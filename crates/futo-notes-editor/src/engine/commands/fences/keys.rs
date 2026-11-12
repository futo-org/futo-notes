//! Keys inside a fence, and the Indent and Outdent buttons on code.
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::{leading, Touch};
use crate::lines::FenceRole;
use crate::{DisplayRange, EditorError, ParagraphKey};
use std::ops::Range;

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
    /// Keys inside a fence: Enter and Shift+Enter, Tab and Shift+Tab.
    pub(in super::super) fn fence_key(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Result<Option<Command>, EditorError> {
        match key {
            ParagraphKey::Enter => Ok(match self.touch(range) {
                Some(Touch::Code(lines)) => Some(
                    match self
                        .enter_after_block(range, &lines)
                        .or_else(|| self.leave_block(range, &lines))
                    {
                        Some(command) => command,
                        None => self.code_break(range, lines.start),
                    },
                ),
                _ => None,
            }),
            ParagraphKey::ShiftEnter => Ok(match self.touch(range) {
                Some(Touch::Code(lines)) => Some(self.code_break(range, lines.start)),
                _ => None,
            }),
            ParagraphKey::Tab | ParagraphKey::ShiftTab => Ok(self
                .touch(range)
                .map(|touch| self.code_indent(range, touch, key == ParagraphKey::ShiftTab, true))),
            ParagraphKey::Backspace
            | ParagraphKey::BackspaceJoiningHeading
            | ParagraphKey::Delete => Ok(None),
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

    /// Enter with a closed block's whole code selected: the block stays and
    /// an empty line opens after its closing line, at its indent.
    fn enter_after_block(&self, range: DisplayRange, lines: &Range<usize>) -> Option<Command> {
        let closing = lines.end;
        if range.start == range.end
            || self.role(lines.start - 1) != Some(FenceRole::Open)
            || closing == self.line_count()
            || self.role(closing) != Some(FenceRole::Close)
        {
            return None;
        }
        let last = self.line_start(closing - 1) + self.line(closing - 1).body_len();
        if self.source_selection(range) != (self.line_start(lines.start)..last) {
            return None;
        }
        Some(self.line_after(closing, closing..closing + 1, Vec::new()))
    }

    /// The command that opens an empty line after closing line `closing` at
    /// its indent, the caret on it, besides `edits`.
    fn line_after(&self, closing: usize, named: Range<usize>, mut edits: Vec<Edit>) -> Command {
        let entry = self.line(closing);
        let at = self.line_start(closing) + entry.body_len();
        let text = format!("{}{}", self.new_ending(closing), leading(entry.body()));
        edits.push(Edit::insert(at, text));
        let mut command = Command::new(edits, named, 0..0);
        let caret = command.map(at, true);
        command.selection = caret..caret;
        command
    }

    /// Enter on an empty last code line of a block that ends the note (only
    /// an empty line may follow its closing line): the empty code line goes
    /// and the caret goes to an empty line after the block, at its indent.
    /// A block that nothing closes is closed there.
    fn leave_block(&self, range: DisplayRange, lines: &Range<usize>) -> Option<Command> {
        if range.start != range.end || lines.len() != 1 {
            return None;
        }
        let index = lines.start;
        let entry = self.line(index);
        if !entry.body().trim_matches([' ', '\t']).is_empty() {
            return None;
        }
        let count = self.line_count();
        let start = self.line_start(index);
        if index + 1 == count {
            // A block nothing closes: close it here.
            let closing = self.closing_text(self.fence_around(index)?);
            let indent = leading(&closing).to_owned();
            let text = format!("{closing}{}{indent}", self.new_ending(index));
            let caret = start + text.len();
            return Some(Command::new(
                vec![Edit::new(start..start + entry.body_len(), text)],
                index..index + 1,
                caret..caret,
            ));
        }
        let closing = index + 1;
        if self.role(closing) != Some(FenceRole::Close) {
            return None;
        }
        let remove = Edit::new(start..self.line_start(closing), "");
        let after = closing + 1;
        if after == count {
            return Some(self.line_after(closing, index..count, vec![remove]));
        }
        if after + 1 == count && self.line(after).text.is_empty() {
            let indent = leading(self.line(closing).body()).to_owned();
            let at = self.line_start(after);
            let mut command =
                Command::new(vec![remove, Edit::insert(at, indent)], index..count, 0..0);
            let caret = command.map(at, true);
            command.selection = caret..caret;
            return Some(command);
        }
        None
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
        if !outdent && (matches!(touch, Touch::Empty(_)) || (collapsed && key)) {
            // At the caret; on an empty block's line this writes the line.
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
