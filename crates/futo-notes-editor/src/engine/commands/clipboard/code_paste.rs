//! Paste in code: the text verbatim, each pasted line after the first at
//! the opening fence's indent, and the fence lengthened (opening and closing
//! line alike) when a line would otherwise close it.
use super::super::super::code_block::fence_indent;
use super::super::super::command::{Command, Edit};
use super::super::super::Engine;
use super::super::fences::Touch;
use crate::DisplayRange;

/// Text pasted in code, with the caret line's line ending its line breaks
/// already take.
pub(super) struct PastedCode<'a> {
    pub text: &'a str,
    pub newline: &'a str,
}

/// The length of the run of fence characters `ch` a line is made of,
/// whitespace around it aside; 0 when it has anything else.
fn fence_run(line: &str, ch: u8) -> usize {
    let own = line.trim_matches([' ', '\t']);
    if !own.is_empty() && own.bytes().all(|b| b == ch) {
        own.len()
    } else {
        0
    }
}

impl Engine {
    pub(super) fn code_paste(
        &self,
        range: DisplayRange,
        touch: Touch,
        pasted: PastedCode,
    ) -> Command {
        let PastedCode { text, newline } = pasted;
        let index = match &touch {
            Touch::Code(lines) => lines.start,
            Touch::Empty(open) => *open,
        };
        let fence = self.fence_around(index).expect("code is in a fence");
        let opening = self.line(fence.open).body();
        let indent = fence_indent(self.line(fence.open));
        let text = text.replace(newline, &format!("{newline}{indent}"));
        let plan = self.plan(range, &text);
        // The code lines as they will read: the pasted text with the rest
        // of the lines it lands on.
        let first = self.line_of(plan.range.start);
        let last = self.line_of(plan.range.end);
        let code = |line: usize| fence.code().contains(&line);
        let before = if code(first) {
            self.source_slice(self.line_start(first)..plan.range.start)
        } else {
            String::new()
        };
        let after = if code(last) {
            let end = self.line_start(last) + self.line(last).body_len();
            self.source_slice(plan.range.end..end.max(plan.range.end))
        } else {
            String::new()
        };
        let lines = format!("{before}{}{after}", plan.inserted);
        let ch = opening.as_bytes()[indent.len()];
        let run = opening[indent.len()..]
            .bytes()
            .take_while(|&b| b == ch)
            .count();
        let longest = lines
            .split(newline)
            .map(|line| fence_run(line, ch))
            .max()
            .unwrap_or(0);
        let mut edits = vec![Edit::new(plan.range.clone(), plan.inserted.clone())];
        let mut caret = plan.caret;
        if longest >= run {
            let extra = (ch as char).to_string().repeat(longest + 1 - run);
            let open_at = self.line_start(fence.open) + indent.len() + run;
            edits.push(Edit::insert(open_at, extra.clone()));
            caret += extra.len();
            if fence.closed {
                let closing = self.line(fence.end).body();
                let lead = closing.len() - closing.trim_start_matches([' ', '\t']).len();
                let close_at = self.line_start(fence.end) + lead;
                edits.push(Edit::insert(close_at, extra));
            }
        }
        Command::new(edits, fence.open..fence.last() + 1, caret..caret)
    }
}
