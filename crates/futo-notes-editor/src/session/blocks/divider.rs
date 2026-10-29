use super::*;
use crate::inline::blocks::BlockLine;

impl EditorSession {
    pub(super) fn insert_divider(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        mut lines: Vec<BlockLine>,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let end_point = DisplayRange {
            start: range.end,
            end: range.end,
        };
        if let Some(last) = self.projection.block_lines(end_point).into_iter().next() {
            if last.source.start > lines.last().unwrap().source.start {
                lines.push(last);
            }
        }
        if lines.iter().any(|line| line.code) {
            return Ok(None);
        }
        let first = &lines[0];
        let last = lines.last().unwrap();
        let start = first.source.start;
        let last_raw = self.source.byte_slice(last.source.clone()).to_string();
        let end = last.source.start + last_raw.trim_end_matches(['\r', '\n']).len();
        // Stage only inline content, retaining each original visible line
        // ending. Block prefixes/closers belong to the two surviving sides,
        // not to the temporary inline document being split.
        let mut body = String::new();
        for (index, line) in lines.iter().enumerate() {
            body.push_str(&self.source.byte_slice(line.content.clone()).to_string());
            if index + 1 < lines.len() {
                let raw = self.source.byte_slice(line.source.clone()).to_string();
                body.push_str(if raw.ends_with("\r\n") {
                    "\r\n"
                } else if raw.ends_with('\n') {
                    "\n"
                } else {
                    ""
                });
            }
        }
        let opened_bytes = body.len();
        let mut staged = Self::open_with_clock(&body, self.clock.clone());
        let display_start = self.projection.display_at(first.content.start);
        let local = DisplayRange {
            start: DisplayOffset(range.start.0 - display_start),
            end: DisplayOffset(range.end.0 - display_start),
        };
        let staged_change = staged.replace_action(
            staged.revision(),
            local,
            "\n\n",
            crate::InputAction::Isolated,
            &mut |_| Ok(()),
        )?;
        let body = staged.source_text();
        let split = body
            .find("\n\n")
            .ok_or(EditorError::UnrepresentableFormat)?;
        let left = &body[..split];
        let right = &body[split + 2..];
        let quote = "> ".repeat(first.quote_depth);
        let first_prefix = self
            .source
            .byte_slice(first.source.start..first.content.start)
            .to_string();
        let first_raw = self.source.byte_slice(first.source.clone()).to_string();
        let first_end = first.source.start + first_raw.trim_end_matches(['\r', '\n']).len();
        let first_suffix = self
            .source
            .byte_slice(first.content.end..first_end)
            .to_string();
        let last_prefix = self
            .source
            .byte_slice(last.source.start..last.content.start)
            .to_string();
        let last_suffix = self.source.byte_slice(last.content.end..end).to_string();
        let lead = if left.is_empty() {
            String::new()
        } else {
            format!("{first_prefix}{left}{first_suffix}\n")
        };
        let index = self.source.byte_to_line(start);
        let previous_nonempty =
            index > 0 && !self.source.line(index - 1).to_string().trim().is_empty();
        let marker = if left.is_empty() && !previous_nonempty {
            "---"
        } else {
            "***"
        };
        let mut output = format!("{lead}{quote}{marker}\n{quote}");
        let caret = start + output.len();
        if !right.is_empty() {
            output.push_str(&format!("\n{last_prefix}{right}{last_suffix}"));
        }
        let mut change =
            self.commit_block_edit(expected, start..end, &output, None, Some(caret), accept)?;
        change.work.materialized_source_bytes +=
            opened_bytes + staged_change.work.materialized_source_bytes;
        change.work.parsed_source_bytes +=
            2 * opened_bytes + staged_change.work.parsed_source_bytes;
        return Ok(Some(change));
    }
}
