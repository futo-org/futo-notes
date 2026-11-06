use super::*;

impl EditorSession {
    pub(super) fn commit_block_key(
        &mut self,
        expected: Revision,
        input: DisplayRange,
        footprint: std::ops::Range<usize>,
        inserted: &str,
        caret: usize,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<ViewChange, EditorError> {
        let formats = (input == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(input);
        let mut change = self.commit_block_edit(
            expected,
            footprint,
            inserted,
            BlockSelection::Source(caret),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        Ok(change)
    }

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
        if matches!(key, ParagraphKey::Enter | ParagraphKey::ShiftEnter)
            && (line.heading > 0 || line.quote_depth > 0)
            && (self.projection.has_block_seams(range)
                || self
                    .projection
                    .has_multiline_block_code(&self.source, range))
        {
            return self.stage_block_action(
                expected,
                range,
                None,
                accept,
                |staged, local, accept| {
                    let seams = staged.split_inline_block_seams(local, accept)?;
                    let Some(mut change) =
                        staged.paragraph_key(staged.revision(), local, key, accept)?
                    else {
                        return Ok(None);
                    };
                    if let Some(seams) = seams {
                        change.work.materialized_source_bytes +=
                            seams.work.materialized_source_bytes;
                        change.work.parsed_source_bytes += seams.work.parsed_source_bytes;

                        change.work.link_metadata_items += seams.work.link_metadata_items;

                        change.work.link_copied_bytes += seams.work.link_copied_bytes;
                    }
                    Ok(Some(change))
                },
            );
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
        if line.content.is_empty() && line.quote_depth > 0 && line.heading == 0 {
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
                        .commit_block_key(
                            expected,
                            range,
                            previous_start..line.content.end,
                            &output,
                            caret,
                            accept,
                        )
                        .map(Some);
                }
            }
            // A quoted line directly under another (Enter continues a quote a
            // line at a time) is dropped and the caret leaves one level.
            let previous = DisplayOffset(
                self.projection
                    .display_at(self.source.line_to_byte(index.saturating_sub(1))),
            );
            if index > 0
                && self
                    .projection
                    .block_lines(DisplayRange {
                        start: previous,
                        end: previous,
                    })
                    .first()
                    .is_some_and(|above| {
                        !above.content.is_empty()
                            && above.quote_depth == line.quote_depth
                            && above.heading == 0
                            && !above.divider
                            && !above.code
                    })
            {
                let quote = "> ".repeat(line.quote_depth - 1);
                let output = format!("{}\n{quote}", quote.trim_end());
                let caret = line.source.start + output.len();
                return self
                    .commit_block_key(
                        expected,
                        range,
                        line.source.start..line.content.end,
                        &output,
                        caret,
                        accept,
                    )
                    .map(Some);
            }
            return self.block_command(expected, range, BlockCommand::Outdent, accept);
        }
        if at_start
            && !line.content.is_empty()
            && (line.heading > 0 || line.quote_start || line.divider)
        {
            return self
                .commit_block_key(
                    expected,
                    range,
                    line.source.start..line.source.start,
                    "\n",
                    line.source.start + 1,
                    accept,
                )
                .map(Some);
        }
        if line.divider {
            let at = line.content.end;
            return self
                .commit_block_key(expected, range, at..at, "\n", at + 1, accept)
                .map(Some);
        }
        self.split_structural_body(expected, range, line, prefix, start_display, accept)
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
        let mut staged = self.stage_source(&raw, window.clone())?;
        let local = DisplayRange {
            start: DisplayOffset(range.start.0 - display_start),
            end: DisplayOffset(range.end.0 - display_start),
        };
        staged.select_with_affinity(staged.revision(), local, self.input_affinity(range))?;
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
        let (selection, selection_work) = if staged.projection.has_rebuilt_references {
            let (mut selection, work) = staged
                .projection
                .source_selection(staged.selection, staged.affinity);
            selection.start.source.0 += window.start;
            selection.end.source.0 += window.start;
            (
                BlockSelection::Exact {
                    selection,
                    window: window.clone(),
                },
                work + 2,
            )
        } else {
            (
                BlockSelection::Display(DisplayRange {
                    start: DisplayOffset(display_start + staged.selection.start.0),
                    end: DisplayOffset(display_start + staged.selection.end.0),
                }),
                0,
            )
        };
        let pending = staged.prepare_pending_for_parent(window.start);
        let mut change = self.commit_block_with_pending(
            expected,
            footprint.start.0..footprint.end.0,
            &inserted,
            selection,
            None,
            Some(pending),
            accept,
        )?;
        self.carry_block_state(&mut change, staged.pending_formats, staged.affinity);
        change.work.materialized_source_bytes += raw.len()
            + deleted.work.materialized_source_bytes
            + entered.work.materialized_source_bytes;
        change.work.parsed_source_bytes += staged.projection.initial_parse_work
            + deleted.work.parsed_source_bytes
            + entered.work.parsed_source_bytes;
        change.work.link_metadata_items += selection_work
            + staged.projection.initial_link_metadata_items
            + deleted.work.link_metadata_items
            + entered.work.link_metadata_items;
        change.work.link_copied_bytes += staged.projection.initial_link_copied_bytes
            + deleted.work.link_copied_bytes
            + entered.work.link_copied_bytes;
        Ok(change)
    }
}

impl EditorSession {
    pub(in crate::session) fn heading_join_backspace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if range.start != range.end {
            return Ok(None);
        }
        let Some(line) = self.projection.block_lines(range).into_iter().next() else {
            return Ok(None);
        };
        if line.heading == 0 || range.start.0 != self.projection.display_at(line.content.start) {
            return Ok(None);
        }
        let index = self.source.byte_to_line(line.source.start);
        if index == 0
            || line.source.start
                <= self
                    .projection
                    .source_bounds(self.projection.body_start())
                    .1
        {
            return Ok(None);
        }
        let previous_start = self.source.line_to_byte(index - 1);
        let previous = self
            .source
            .byte_slice(previous_start..line.source.start)
            .to_string();
        let blank = previous.trim().is_empty()
            || line.quote_depth > 0 && previous.trim() == "> ".repeat(line.quote_depth).trim();
        if blank {
            return self
                .commit_block_key(
                    expected,
                    range,
                    previous_start..line.source.start,
                    "",
                    line.content.start - previous.len(),
                    accept,
                )
                .map(Some);
        }
        // Retire only the heading frame, then use ordinary paragraph deletion
        // to preserve the established list, quote, code and table join rules.
        // Both changes stay invisible until one protected source acceptance.
        self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
            let demoted =
                staged.block_command(staged.revision(), local, BlockCommand::Heading(0), accept)?;
            let mut joined = staged.paragraph_key(
                staged.revision(),
                staged.selection(),
                ParagraphKey::Backspace,
                accept,
            )?;
            if let (Some(demoted), Some(joined)) = (&demoted, &mut joined) {
                accumulate_planning_work(&mut joined.work, demoted.work);
            }
            Ok(joined.or(demoted))
        })
    }
}
