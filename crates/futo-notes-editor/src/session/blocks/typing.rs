use super::*;

impl EditorSession {
    pub(in crate::session) fn input_before_lazy_quote_neighbor(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if inserted
            .split(['\r', '\n'])
            .next()
            .unwrap_or("")
            .trim_matches([' ', '\t'])
            .is_empty()
        {
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        if !self
            .source
            .byte_slice(line.content.clone())
            .chars()
            .all(|ch| matches!(ch, ' ' | '\t'))
            || range.end.0 > self.projection.display_at(line.content.end)
            || line.heading > 0
            || line.quote_depth == 0
            || line.divider
            || line.code
        {
            return Ok(None);
        }
        let Some(separator) =
            self.quote_neighbor_separator(line.source.end, line.quote_depth, true)
        else {
            return Ok(None);
        };
        self.stage_block_action(expected, range, accept, |staged, local, accept| {
            let line = staged.projection.block_lines(local).remove(0);
            let formats = staged.pending_formats.clone();
            let affinity = staged.affinity;
            let mut boundary = staged.commit_block_edit(
                staged.revision(),
                line.source.end..line.source.end,
                &separator,
                Some(local),
                None,
                accept,
            )?;
            staged.carry_block_state(&mut boundary, formats, affinity);
            let mut input =
                staged.replace_action(staged.revision(), local, inserted, action, accept)?;
            input.work.materialized_source_bytes += boundary.work.materialized_source_bytes;
            input.work.parsed_source_bytes += boundary.work.parsed_source_bytes;
            Ok(Some(input))
        })
    }

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
        let command = if let Some(hashes) = heading {
            BlockCommand::Heading(hashes.len() as u8)
        } else if quote {
            BlockCommand::Quote
        } else {
            BlockCommand::Divider
        };
        self.stage_block_action(expected, range, accept, |staged, local, accept| {
            let line = staged.projection.block_lines(local).remove(0);
            let prefix = DisplayRange {
                start: DisplayOffset(staged.projection.display_at(line.content.start)),
                end: local.start,
            };
            let removed = staged.replace_action(
                staged.revision(),
                prefix,
                "",
                crate::InputAction::Isolated,
                accept,
            )?;
            let formats = staged.pending_formats.clone();
            let mut change = staged
                .block_command(staged.revision(), staged.selection(), command, accept)?
                .ok_or(EditorError::UnrepresentableFormat)?;
            staged.pending_formats = formats;
            change.work.materialized_source_bytes += removed.work.materialized_source_bytes;
            change.work.parsed_source_bytes += removed.work.parsed_source_bytes;
            Ok(Some(change))
        })
    }
}
