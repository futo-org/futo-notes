//! Opening an empty line before or after a code block, and a code line
//! above or below a code line. Hosts reach for the first where no line
//! borders a block (it starts or ends the note, or another block touches
//! it): Enter in code always writes code.
use super::super::super::code_block::{fence_indent, is_code_line, is_opening_fence, CodeBlock};
use super::super::super::command::{Command, Edit};
use super::super::super::{store, Engine};
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

    /// A new code line below (`below`) the code line `range` ends on, or
    /// above the one it starts on, the caret on it: at the indent Enter at
    /// that line's end writes (the opening fence's, then the shown code's
    /// leading whitespace). On an empty block it writes the block's first
    /// code line and a second one, the caret on the second (below) or the
    /// first (above). `None` outside code.
    pub(in super::super) fn open_code_line(
        &self,
        range: DisplayRange,
        below: bool,
    ) -> Option<Command> {
        let at = if below { range.end.0 } else { range.start.0 };
        let (index, _) = self.line_at_display(store::display, at);
        let entry = self.line(index);
        if !is_code_line(entry) {
            return None;
        }
        let ending = self.new_ending(index);
        let end = self.line_start(index) + entry.body_len();
        if is_opening_fence(entry) {
            let line = format!("{ending}{}", fence_indent(entry));
            let caret = end + line.len() * if below { 2 } else { 1 };
            let text = format!("{line}{line}");
            return Some(Command::new(
                vec![Edit::insert(end, text)],
                index..index + 1,
                caret..caret,
            ));
        }
        let indent = format!(
            "{}{}",
            fence_indent(entry),
            leading(&entry.body()[entry.line.marker.end..])
        );
        let (written_at, text, caret) = if below {
            let text = format!("{ending}{indent}");
            (end, text, end + ending.len() + indent.len())
        } else {
            let start = self.line_start(index);
            (start, format!("{indent}{ending}"), start + indent.len())
        };
        Some(Command::new(
            vec![Edit::insert(written_at, text)],
            index..index + 1,
            caret..caret,
        ))
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
        let text = line_after_closing(&self.new_ending(closing), entry.body());
        let caret = at + text.len();
        Command::new(
            vec![Edit::insert(at, text)],
            closing..closing + 1,
            caret..caret,
        )
    }
}

/// What opens an empty line after a closing fence line `closing` (its text
/// without an ending): `ending`, then the closing fence's indent.
pub(in super::super) fn line_after_closing(ending: &str, closing: &str) -> String {
    format!("{ending}{}", leading(closing))
}
