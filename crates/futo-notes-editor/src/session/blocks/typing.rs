use super::*;

impl EditorSession {
    pub(in crate::session) fn input_at_divider(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if range.start != range.end || inserted.is_empty() {
            return Ok(None);
        }
        let Some(line) = self
            .projection
            .block_lines(range)
            .into_iter()
            .find(|line| line.divider)
        else {
            return Ok(None);
        };
        let before = range.start.0 == self.projection.display_at(line.content.start);
        let after = range.start.0 == self.projection.display_at(line.content.end);
        if !before && !after {
            return Ok(None);
        }
        let mut staged = Self::open_with_clock("", self.clock.clone());
        let input = staged.replace_action(
            staged.revision(),
            DisplayRange::default(),
            inserted,
            crate::InputAction::Isolated,
            &mut |_| Ok(()),
        )?;
        let raw = staged.source_text();
        let quote = "> ".repeat(line.quote_depth);
        let (at, text, caret) = if before {
            (
                line.source.start,
                format!("{quote}{raw}\n"),
                line.source.start + quote.len() + raw.len(),
            )
        } else {
            (
                line.content.end,
                format!("\n{quote}{raw}"),
                line.content.end + 1 + quote.len() + raw.len(),
            )
        };
        let dash_divider = before
            && self
                .source
                .byte_slice(line.content.clone())
                .to_string()
                .trim_start()
                .starts_with('-');
        let (footprint, text) = if dash_divider {
            (
                line.source.start..line.content.end,
                format!("{text}{quote}***"),
            )
        } else {
            (at..at, text)
        };
        let mut change =
            self.commit_block_edit(expected, footprint, &text, None, Some(caret), accept)?;
        change.work.materialized_source_bytes += input.work.materialized_source_bytes;
        change.work.parsed_source_bytes += input.work.parsed_source_bytes;
        Ok(Some(change))
    }

    pub(in crate::session) fn line_start_conversion(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if range.start != range.end {
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        if line.code || line.heading > 0 || line.divider {
            return Ok(None);
        }
        let start_display = self.projection.display_at(line.content.start);
        let mut prefix = self
            .projection
            .display
            .byte_slice(start_display..range.start.0)
            .to_string();
        prefix.push_str(inserted);
        let heading = prefix
            .strip_suffix(' ')
            .filter(|s| !s.is_empty() && s.len() <= 6 && s.bytes().all(|ch| ch == b'#'));
        let quote = prefix == "> ";
        let divider = matches!(prefix.as_str(), "---" | "___ " | "*** ")
            && range.start.0 == self.projection.display_at(line.content.end);
        if heading.is_none() && !quote && !divider {
            return Ok(None);
        }
        let at = self.source_at(expected, range.start, Affinity::Backward)?.0;
        let replacement = if divider {
            let index = self.source.byte_to_line(line.source.start);
            let previous_nonempty =
                index > 0 && !self.source.line(index - 1).to_string().trim().is_empty();
            format!("{}\n", if previous_nonempty { "***" } else { "---" })
        } else {
            prefix
        };
        let caret = line.content.start + replacement.len();
        let mut end = at;
        let mut replacement = replacement;
        if quote && line.source.end < self.source.len_bytes() {
            let next_display = self.projection.display_at(line.source.end);
            let next_range = DisplayRange {
                start: DisplayOffset(next_display),
                end: DisplayOffset(next_display),
            };
            if self
                .projection
                .block_lines(next_range)
                .first()
                .is_some_and(|next| {
                    !next.content.is_empty()
                        && next.quote_depth <= line.quote_depth
                        && next.heading == 0
                        && !next.divider
                        && !next.code
                })
            {
                replacement.push_str(&self.source.byte_slice(at..line.source.end).to_string());
                replacement.push_str(&format!("{}\n", "> ".repeat(line.quote_depth).trim_end()));
                end = line.source.end;
            }
        }
        self.commit_block_edit(
            expected,
            line.content.start..end,
            &replacement,
            None,
            Some(caret),
            accept,
        )
        .map(Some)
    }
}
