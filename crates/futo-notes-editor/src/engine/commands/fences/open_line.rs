//! Opening an empty line before or after a code block. Hosts reach for it
//! where no line borders a block (it starts or ends the note, or another
//! block touches it): Enter in code always writes code.
use super::super::super::code_block::CodeBlock;
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::{leading, Fence};
use crate::DisplayRange;

impl Engine {
    /// An empty line after (`after`) or before the code block whose code
    /// shows at the start of `range`, the caret on it; `None` outside code.
    pub(in super::super) fn open_line_beside_block(
        &self,
        range: DisplayRange,
        after: bool,
    ) -> Option<Command> {
        let block = self.block_at(range.start.0)?;
        Some(if after {
            self.line_after_block(&block)
        } else {
            self.line_before_block(&block)
        })
    }

    /// A line before the opening fence, at its indent.
    fn line_before_block(&self, block: &CodeBlock) -> Command {
        let opener = block.opener;
        let at = self.line_start(opener);
        let indent = leading(self.line(opener).body());
        let caret = at + indent.len();
        let text = format!("{indent}{}", self.new_ending(opener));
        Command::new(
            vec![Edit::insert(at, text)],
            opener..opener + 1,
            caret..caret,
        )
    }

    /// A line after the closing fence, at its indent. A block nothing
    /// closes is closed first.
    fn line_after_block(&self, block: &CodeBlock) -> Command {
        if let Some(closer) = block.closer {
            return self.line_after(closer);
        }
        let last = block.last;
        let at = self.line_start(last) + self.line(last).body_len();
        let closing = self.closing_text(Fence {
            open: block.opener,
            end: last + 1,
            closed: false,
        });
        let ending = self.new_ending(last);
        let text = format!("{ending}{closing}{ending}{}", leading(&closing));
        let caret = at + text.len();
        Command::new(vec![Edit::insert(at, text)], last..last + 1, caret..caret)
    }

    /// An empty line after closing line `closing`, at its indent.
    fn line_after(&self, closing: usize) -> Command {
        let entry = self.line(closing);
        let at = self.line_start(closing) + entry.body_len();
        let text = format!("{}{}", self.new_ending(closing), leading(entry.body()));
        let caret = at + text.len();
        Command::new(
            vec![Edit::insert(at, text)],
            closing..closing + 1,
            caret..caret,
        )
    }
}
