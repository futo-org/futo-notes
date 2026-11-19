//! Backspace and Delete at a caret beside a code block's hidden fences, where
//! removing the line break would join a fence to the line beside it. They
//! select the block instead (removing a blank line beside it), or do nothing.
use super::super::super::code_block::CodeBlock;
use super::super::super::command::{Command, Edit};
use super::super::super::line::Role;
use super::super::super::{store, Engine};
use crate::lines::FenceRole;
use crate::{DisplayRange, ParagraphKey};

impl Engine {
    /// Backspace or Delete at a caret at a block's edge, when that is where
    /// `range` is.
    pub(super) fn block_edge_key(&self, range: DisplayRange, key: ParagraphKey) -> Option<Command> {
        if range.start != range.end {
            return None;
        }
        match key {
            ParagraphKey::Backspace
            | ParagraphKey::BackspaceJoiningHeading
            | ParagraphKey::PairedBackspace => self.backspace_at_block(range),
            ParagraphKey::Delete => self.delete_at_block(range),
            _ => None,
        }
    }

    /// Backspace in a block down to one empty line selects it; at the start
    /// of its code it does nothing. At the start of a line right after a
    /// closing fence, a line no other family claims (no marker), it selects
    /// the block, and removes the line when it is blank. At the start of the
    /// note, on a blank first line above an opening fence, it removes that
    /// line, so the block opens the note.
    fn backspace_at_block(&self, range: DisplayRange) -> Option<Command> {
        let at = range.start.0;
        if let Some(block) = self.code_block_at(at) {
            if block.first == block.last && self.line(block.first).shown_len() == 0 {
                return Some(self.block_selecting(&block, Vec::new()));
            }
            return (at == block.description.range.start.0).then(|| self.staying(range));
        }
        let (index, before) = self.line_at_display(store::display, at);
        if at == 0
            && self.line_count() > 1
            && self.role(1) == Some(FenceRole::Open)
            && self.is_blank(0)
        {
            return Some(self.blank_line_removed(0));
        }
        if at != before.display || index == 0 || self.role(index - 1) != Some(FenceRole::Close) {
            return None;
        }
        let entry = self.line(index);
        let blank = self.is_blank(index);
        if !blank && !entry.line.marker.is_empty() {
            return None;
        }
        let closer = index - 1;
        let block = CodeBlock::holding(&self.store, closer - 1);
        if !blank {
            return Some(self.block_selecting(&block, Vec::new()));
        }
        let from = self.line_start(closer) + self.line(closer).body_len();
        let to = self.line_start(index) + entry.body_len();
        let mut command = self.block_selecting(&block, vec![Edit::new(from..to, "")]);
        command.lines[0] = closer..index + 1;
        Some(command)
    }

    /// Delete at the end of a block's code does nothing. At the end of the
    /// line right before an opening fence it selects the block; a blank line
    /// there is removed instead, and the caret goes into the code.
    fn delete_at_block(&self, range: DisplayRange) -> Option<Command> {
        let at = range.start.0;
        if let Some(block) = self.code_block_at(at) {
            return (at == block.description.range.end.0).then(|| self.staying(range));
        }
        let (index, before) = self.line_at_display(store::display, at);
        let entry = self.line(index);
        let opener = index + 1;
        if at != before.display + entry.shown_len()
            || opener >= self.line_count()
            || self.role(opener) != Some(FenceRole::Open)
        {
            return None;
        }
        if !self.is_blank(index) {
            return Some(self.block_selecting(&self.block_opened(opener), Vec::new()));
        }
        Some(self.blank_line_removed(index))
    }

    /// Whether line `index` holds only spaces and tabs.
    fn is_blank(&self, index: usize) -> bool {
        self.line(index).body().trim_matches([' ', '\t']).is_empty()
    }

    /// The block opening fence line `opener` opens.
    fn block_opened(&self, opener: usize) -> CodeBlock {
        let empty = self.line(opener).view.role == Role::Empty;
        CodeBlock::holding(&self.store, opener + usize::from(!empty))
    }

    /// Blank line `index`, right above an opening fence, removed, the caret
    /// at the start of the block's code.
    fn blank_line_removed(&self, index: usize) -> Command {
        let opener = index + 1;
        let start = self.line_start(index);
        let removed = self.line(index).text.len();
        let caret = self.line_start(self.block_opened(opener).first) - removed;
        Command::new(
            vec![Edit::new(start..self.line_start(opener), "")],
            index..index + 1,
            caret..caret,
        )
    }

    /// A command that leaves the caret where it is.
    fn staying(&self, range: DisplayRange) -> Command {
        let at = self.source_selection(range).start;
        let index = self.line_of(at);
        Command::new(Vec::new(), index..index + 1, at..at)
    }

    /// `edits` (none before the block), then `block` selected as one object.
    fn block_selecting(&self, block: &CodeBlock, edits: Vec<Edit>) -> Command {
        let at = self.line_start(block.first);
        let mut command = Command::new(edits, block.first..block.first + 1, at..at);
        command.selects_block = true;
        command
    }
}
