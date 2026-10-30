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
        let body = self.split_block_body(&lines, range)?;
        let setext = first.underline.is_some();
        let heading_end = if setext {
            body.left.trim_end_matches(['\r', '\n']).len()
        } else {
            body.left.len()
        };
        let retained_break = &body.left[heading_end..];
        let (left, left_work) = super::content::protect_content(
            &body.left[..heading_end],
            first.heading > 0 && !setext,
            setext || first.heading == 0,
        );
        let (right, right_work) = super::content::protect_content(
            &body.right,
            last.heading > 0 && last.underline.is_none(),
            last.underline.is_some() || last.heading == 0,
        );
        let left = super::content::restore_body_prefixes(&left, body.prefixes.iter().skip(1));
        let right = super::content::restore_body_prefixes(
            &right,
            body.prefixes.iter().skip(body.right_line + 1),
        );
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
        let last_prefix = &body.prefixes[body.right_line];
        // A lazy continuation needs an explicit container when it becomes the
        // first body after the new divider boundary.
        let last_prefix = if last_prefix.bytes().filter(|ch| *ch == b'>').count() < last.quote_depth
        {
            format!("{}{last_prefix}", "> ".repeat(last.quote_depth))
        } else {
            last_prefix.clone()
        };
        let last_suffix = self.source.byte_slice(last.content.end..end).to_string();
        let lead = if left.is_empty() {
            String::new()
        } else {
            format!("{first_prefix}{left}{first_suffix}{retained_break}\n")
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
        let mut change = self.commit_block_edit(
            expected,
            start..end,
            &output,
            BlockSelection::Source(caret),
            None,
            accept,
        )?;
        change.work.materialized_source_bytes += body.materialized;
        change.work.parsed_source_bytes += body.parsed + left_work + right_work;
        change.work.link_metadata_items += body.link_metadata_items;
        change.work.link_copied_bytes += body.link_copied_bytes;
        Ok(Some(change))
    }
}
