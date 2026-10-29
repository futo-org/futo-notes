use super::*;

impl EditorSession {
    pub(in crate::session) fn structural_key(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        key: ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if range.start != range.end {
            if matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter)
                && self
                    .projection
                    .block_lines(range)
                    .iter()
                    .any(|line| line.heading > 0 || line.quote_depth > 0 || line.divider)
            {
                return self
                    .structural_selection_enter(expected, range, key, accept)
                    .map(Some);
            }
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        if line.code {
            return Ok(None);
        }
        let start_display = self.projection.display_at(line.content.start);
        let at_start = range.start.0 == start_display;
        let prefix = self
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        if key == ParagraphKey::Delete
            && line.quote_depth > 0
            && range.start.0 == self.projection.display_at(line.content.end)
        {
            let mut index = self.source.byte_to_line(line.source.start) + 1;
            if index < self.source.len_lines() {
                if self.source.line(index).to_string().trim()
                    == "> ".repeat(line.quote_depth).trim()
                {
                    index += 1;
                }
                if index < self.source.len_lines() {
                    let next_display = self.projection.display_at(self.source.line_to_byte(index));
                    let point = DisplayRange {
                        start: DisplayOffset(next_display),
                        end: DisplayOffset(next_display),
                    };
                    if let Some(next) = self.projection.block_lines(point).first() {
                        if next.quote_depth == line.quote_depth
                            && !next.content.is_empty()
                            && !next.code
                            && !next.divider
                            && next.heading == 0
                        {
                            let join = DisplayRange {
                                start: range.start,
                                end: DisplayOffset(self.projection.display_at(next.content.start)),
                            };
                            return self
                                .replace_action(
                                    expected,
                                    join,
                                    "",
                                    crate::InputAction::Isolated,
                                    accept,
                                )
                                .map(Some);
                        }
                    }
                }
            }
        }
        if key == ParagraphKey::Backspace && at_start && (line.heading > 0 || line.quote_depth > 0)
        {
            if line.quote_depth > 0 && !line.quote_start {
                let mut index = self.source.byte_to_line(line.source.start);
                if index > 0 {
                    index -= 1;
                    if self.source.line(index).to_string().trim()
                        == "> ".repeat(line.quote_depth).trim()
                        && index > 0
                    {
                        index -= 1;
                    }
                    let previous_source = self.source.line_to_byte(index);
                    let previous_display = self.projection.display_at(previous_source);
                    let point = DisplayRange {
                        start: DisplayOffset(previous_display),
                        end: DisplayOffset(previous_display),
                    };
                    if let Some(previous) = self.projection.block_lines(point).first() {
                        if previous.quote_depth == line.quote_depth
                            && !previous.content.is_empty()
                            && !previous.code
                            && !previous.divider
                            && previous.heading == 0
                        {
                            let join = DisplayRange {
                                start: DisplayOffset(
                                    self.projection.display_at(previous.content.end),
                                ),
                                end: range.start,
                            };
                            return self
                                .replace_action(
                                    expected,
                                    join,
                                    "",
                                    crate::InputAction::Isolated,
                                    accept,
                                )
                                .map(Some);
                        }
                    }
                }
            }
            let command = if line.heading > 0 {
                BlockCommand::Heading(0)
            } else {
                BlockCommand::Outdent
            };
            return self.block_command(expected, range, command, accept);
        }
        if !matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter) {
            return Ok(None);
        }
        if line.heading == 0 && line.quote_depth == 0 && !line.divider {
            return Ok(None);
        }
        if line.content.is_empty() && line.quote_depth > 0 {
            let index = self.source.byte_to_line(line.source.start);
            if index > 0 {
                let previous_start = self.source.line_to_byte(index - 1);
                let previous = self
                    .source
                    .byte_slice(previous_start..line.source.start)
                    .to_string();
                if previous.trim_end_matches(['\r', '\n']).trim()
                    == "> ".repeat(line.quote_depth).trim()
                {
                    let quote = "> ".repeat(line.quote_depth - 1);
                    let output = format!("{}\n{quote}", quote.trim_end());
                    let caret = previous_start + output.len();
                    return self
                        .commit_block_edit(
                            expected,
                            previous_start..line.content.end,
                            &output,
                            None,
                            Some(caret),
                            accept,
                        )
                        .map(Some);
                }
            }
            return self.block_command(expected, range, BlockCommand::Outdent, accept);
        }
        if at_start
            && !line.content.is_empty()
            && (line.heading > 0 || line.quote_start || line.divider)
        {
            return self
                .commit_block_edit(
                    expected,
                    line.source.start..line.source.start,
                    "\n",
                    None,
                    Some(line.source.start + 1),
                    accept,
                )
                .map(Some);
        }
        if line.divider {
            let at = line.content.end;
            return self
                .commit_block_edit(expected, at..at, "\n", None, Some(at + 1), accept)
                .map(Some);
        }
        let raw = self.source.byte_slice(line.content.clone()).to_string();
        let mut staged = Self::open_with_clock(&raw, self.clock.clone());
        let offset = range.start.0 - start_display;
        let local = DisplayRange {
            start: DisplayOffset(offset),
            end: DisplayOffset(offset),
        };
        // A heading ends its inline block at Enter. A temporary blank line asks
        // the inline owner to close/reopen its spans before splitting that block.
        let separator = "\n\n";
        let staged_change = staged.replace_action(
            staged.revision(),
            local,
            separator,
            crate::InputAction::Isolated,
            &mut |_| Ok(()),
        )?;
        let mut body = staged.source_text();
        let split = body
            .find(separator)
            .ok_or(EditorError::UnrepresentableFormat)?;
        body.remove(split + 1);
        let suffix_end = line.source.start
            + self
                .source
                .byte_slice(line.source.clone())
                .to_string()
                .trim_end_matches(['\r', '\n'])
                .len();
        let suffix = self
            .source
            .byte_slice(line.content.end..suffix_end)
            .to_string();
        let continuation = if line.quote_depth > 0 {
            "> ".repeat(line.quote_depth)
        } else {
            String::new()
        };
        let separator = if line.quote_depth > 0 && line.heading == 0 {
            format!("{}\n", continuation.trim_end())
        } else {
            String::new()
        };
        let output = format!(
            "{prefix}{}{}\n{separator}{continuation}{}",
            &body[..split],
            suffix,
            &body[split + 1..]
        );
        let caret = line.source.start
            + prefix.len()
            + split
            + suffix.len()
            + 1
            + separator.len()
            + continuation.len();
        let mut change = self.commit_block_edit(
            expected,
            line.source.start..suffix_end,
            &output,
            None,
            Some(caret),
            accept,
        )?;
        change.work.materialized_source_bytes +=
            raw.len() + staged_change.work.materialized_source_bytes;
        change.work.parsed_source_bytes += 2 * raw.len() + staged_change.work.parsed_source_bytes;
        Ok(Some(change))
    }

    fn structural_selection_enter(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        key: ParagraphKey,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let (window, display_start) = self.projection.edit_window(range);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = Self::open_with_clock(&raw, self.clock.clone());
        let local = DisplayRange {
            start: DisplayOffset(range.start.0 - display_start),
            end: DisplayOffset(range.end.0 - display_start),
        };
        staged.select_with_affinity(staged.revision(), local, self.affinity)?;
        let mut transaction = crate::history::Transaction::new(&staged.source);
        let mut capture = |edit: &SourceEdit| {
            transaction.apply(edit.range, &edit.inserted);
            Ok(())
        };
        let deleted = staged.replace_action(
            staged.revision(),
            local,
            "",
            crate::InputAction::Isolated,
            &mut capture,
        )?;
        let entered = staged
            .paragraph_key(staged.revision(), staged.selection(), key, &mut capture)?
            .unwrap();
        let (mut footprint, inserted) = transaction.finish();
        footprint.start.0 += window.start;
        footprint.end.0 += window.start;
        let selection = DisplayRange {
            start: DisplayOffset(display_start + staged.selection.start.0),
            end: DisplayOffset(display_start + staged.selection.end.0),
        };
        let mut change = self.commit_block_edit(
            expected,
            footprint.start.0..footprint.end.0,
            &inserted,
            Some(selection),
            None,
            accept,
        )?;
        change.work.materialized_source_bytes += raw.len()
            + deleted.work.materialized_source_bytes
            + entered.work.materialized_source_bytes;
        change.work.parsed_source_bytes +=
            2 * raw.len() + deleted.work.parsed_source_bytes + entered.work.parsed_source_bytes;
        Ok(change)
    }
}
