//! A code block selected as one object. The selection is then the block's
//! display range and `block_selected` says it is the block, not its code:
//! Backspace, Delete, typing, cut and copy take it whole, fences and all
//! (`reach.rs`), and Enter puts the caret at the end of its code (below an
//! empty block). Any other
//! selection, and any edit, ends it; an echo of the same range keeps it.
use super::super::super::code_block::{is_code_line, CodeBlock};
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use crate::{DisplayOffset, DisplayRange, EditorError, ParagraphKey, Revision, SelectionChange};

impl Engine {
    /// Select the code block holding source offset `at` as one object; a
    /// line that is not code leaves the selection as it is.
    pub(crate) fn select_block_at(&mut self, at: usize) {
        let index = self.line_of(at);
        if !is_code_line(self.line(index)) {
            return;
        }
        self.selection = CodeBlock::holding(&self.store, index).description.range;
        self.pin = None;
        self.typing = None;
        self.formats = None;
        self.block_selected = true;
    }

    /// Select, as one object, the code block whose code shows at display
    /// offset `at` (a host's tap on its header).
    pub fn select_code_block(
        &mut self,
        expected: Revision,
        at: DisplayOffset,
    ) -> Result<SelectionChange, EditorError> {
        self.check_revision(expected)?;
        self.check_display(at.0)?;
        if self.composition.is_some() {
            return Err(EditorError::CompositionActive);
        }
        let block = self.block_at(at.0).ok_or(EditorError::InvalidRange)?;
        self.select_block_at(self.line_start(block.first));
        Ok(self.selection_change())
    }

    /// A key on the selected block, when `range` is the selection: Backspace
    /// and Delete remove it whole; Enter puts the caret at the end of its
    /// last code line, or below an empty block (`below_block`). Other keys
    /// act on its code.
    pub(super) fn selected_block_key(
        &self,
        range: DisplayRange,
        key: ParagraphKey,
    ) -> Option<Command> {
        if !self.block_selected || range != self.selection {
            return None;
        }
        match key {
            ParagraphKey::Backspace
            | ParagraphKey::BackspaceJoiningHeading
            | ParagraphKey::PairedBackspace
            | ParagraphKey::Delete => Some(self.removed(range)),
            ParagraphKey::Enter | ParagraphKey::ShiftEnter => {
                let block = self.block_at(range.start.0)?;
                if block.first == block.opener {
                    return Some(self.below_block(&block));
                }
                let end = self.line_start(block.last) + self.line(block.last).body_len();
                Some(Command::new(
                    Vec::new(),
                    block.last..block.last + 1,
                    end..end,
                ))
            }
            ParagraphKey::Tab | ParagraphKey::ShiftTab | ParagraphKey::Transpose => None,
        }
    }

    /// Enter over exactly all of a block's code (an ordinary selection):
    /// the code goes and the block keeps one empty code line.
    pub(super) fn emptied_block(&self, range: DisplayRange) -> Option<Command> {
        if range.start == range.end || self.block_selected {
            return None;
        }
        let block = self.block_at(range.start.0)?;
        (block.description.range == range).then(|| self.removed(range))
    }

    /// Display `range` removed as Backspace over it removes it.
    fn removed(&self, range: DisplayRange) -> Command {
        let plan = self.plan(range, "");
        let lines = self.line_of(plan.range.start)..self.line_of(plan.range.end) + 1;
        let mut command = Command::new(
            vec![Edit::new(plan.range, plan.inserted)],
            lines,
            plan.caret..plan.caret,
        );
        command.typed = true;
        command
    }
}
