#[path = "block_prefix_command.rs"]
mod prefix_command;

use super::*;

impl EditorSession {
    pub fn block_command_utf16(
        &mut self,
        expected: Revision,
        range: crate::DisplayUtf16Range,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let (range, _) = self.decode_utf16_input(expected, range, &[])?;
        self.block_command(expected, range, command, accept)
    }

    /// Tab and Shift+Tab in a list item run the toolbar's Indent and Outdent
    /// commands, and do nothing where those buttons are disabled. Outside
    /// lists and code, Tab is not an indent key.
    pub(in crate::session) fn list_tab(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        outdent: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if indent_item(&self.selected_block_lines(range)).is_none() {
            return Ok(None);
        }
        self.indent_command(expected, range, outdent, accept)
    }

    /// Indent and Outdent are the toolbar's list nesting and code tabs
    /// ([`Self::indent_command`]); every other command respells blocks through
    /// [`Self::structural_command`].
    pub fn block_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        match command {
            BlockCommand::Indent => self.indent_command(expected, range, false, accept),
            BlockCommand::Outdent => self.indent_command(expected, range, true, accept),
            _ => self.structural_command(expected, range, command, accept),
        }
    }

    /// A key's own lift out of a quote or list (Backspace, Enter on an empty
    /// quoted line) and the Quote toggle take `Outdent` as one container level.
    pub(in crate::session) fn structural_command(
        &mut self,
        expected: Revision,
        mut range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        if self.composition().is_some() {
            return self.command_during_composition(
                expected,
                range,
                accept,
                |staged, local, accept| {
                    staged.structural_command(staged.revision(), local, command, accept)
                },
            );
        }
        self.validate_range(range)?;
        range = self.body_range(range)?;
        // New lines take the caret line's spelling, as Enter's do.
        if matches!(
            command,
            BlockCommand::Divider | BlockCommand::CodeBlock | BlockCommand::WrapCodeBlock
        ) {
            let (at, _) = self.projection.source_bounds(range.start.0);
            if self.line_ending_at(at) == "\r\n" {
                return self.crlf_block_command(expected, range, command, accept);
            }
        }
        self.lf_block_command(expected, range, command, accept)
    }

    /// `block_command` on a validated body range, writing LF line breaks.
    pub(in crate::session) fn lf_block_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.lf_block_command_toggling(expected, range, command, true, accept)
    }

    /// `toggle_quote` is false for a step that carries out a direction already
    /// chosen on the selection as given, so a staged copy never re-decides it.
    fn lf_block_command_toggling(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        toggle_quote: bool,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let command = if let BlockCommand::ToggleHeading(level) = command {
            if !(1..=6).contains(&level) {
                return Err(EditorError::InvalidRange);
            }
            let lines = self.selected_block_lines(range);
            if common_heading(&self.content_block_lines(&lines)) == Some(level) {
                BlockCommand::Heading(0)
            } else {
                BlockCommand::Heading(level)
            }
        } else {
            command
        };
        if command == BlockCommand::WrapCodeBlock {
            return self.wrap_code_block(expected, range, accept);
        }
        if matches!(command, BlockCommand::Heading(level) if level > 6) {
            return Err(EditorError::InvalidRange);
        }
        if command == BlockCommand::CodeBlock {
            return self.code_block_command(expected, range, accept);
        }
        if command == BlockCommand::Outdent
            && self
                .projection
                .block_lines(range)
                .iter()
                .any(|line| line.code)
        {
            return self.fence_indent(expected, range, true, false, accept);
        }
        if command == BlockCommand::ToggleTask {
            return self.toggle_task(expected, range, accept);
        }
        if matches!(
            command,
            BlockCommand::BulletList | BlockCommand::OrderedList | BlockCommand::TaskList
        ) || command == BlockCommand::Heading(0)
            && self
                .selected_block_lines(range)
                .iter()
                .any(|line| line.list.is_some())
        {
            return self.list_command(expected, range, command, accept);
        }
        if command == BlockCommand::Outdent
            && self
                .selected_block_lines(range)
                .first()
                .is_some_and(|line| {
                    line.list.as_ref().is_some_and(|list| {
                        list.first
                            && line.source.contains(&list.marker.start)
                            && line.quote_depth != list.quote_depth
                    })
                })
        {
            // A quote inside a list item is outside the generic list path.
            return Err(EditorError::UnrepresentableFormat);
        }
        if command == BlockCommand::Outdent
            && self
                .selected_block_lines(range)
                .first()
                .is_some_and(|line| {
                    !line.code
                        && line
                            .list
                            .as_ref()
                            .is_some_and(|list| line.quote_depth == list.quote_depth)
                })
        {
            return self.indent_list(expected, range, BlockCommand::Outdent, accept);
        }
        let mut lines = self.selected_block_lines(range);
        // Choosing Quote on text that is already quoted takes one level off.
        let command = if toggle_quote
            && command == BlockCommand::Quote
            && all_quoted(&self.content_block_lines(&lines))
        {
            BlockCommand::Outdent
        } else {
            command
        };
        // Blank lines between the lines a heading is set on stay as they are.
        if matches!(command, BlockCommand::Heading(1..=6)) {
            let keep: Vec<_> = self
                .content_block_lines(&lines)
                .into_iter()
                .map(|line| line.source.start)
                .collect();
            lines.retain(|line| keep.binary_search(&line.source.start).is_ok());
        }
        if matches!(command, BlockCommand::Heading(1..=6) | BlockCommand::Quote)
            && lines.iter().any(|line| {
                !line.code
                    && line.list.is_some()
                    && (command != BlockCommand::Quote || line.quote_depth == 0)
            })
        {
            let owns_endpoint = range.start != range.end
                && lines.last().is_some_and(|line| {
                    line.list.as_ref().is_some_and(|list| list.first)
                        && self.projection.display_at(line.content.start) == range.end.0
                });
            return self.stage_block_action(
                expected,
                range,
                None,
                accept,
                |staged, local, accept| {
                    let Some(lifted) = staged.block_command(
                        staged.revision(),
                        local,
                        BlockCommand::Heading(0),
                        accept,
                    )?
                    else {
                        return Ok(None);
                    };
                    let local = staged.selection();
                    if staged
                        .projection
                        .block_lines(local)
                        .iter()
                        .any(|line| line.list.is_some())
                    {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    // The opening formatting scope includes a list item's first
                    // text boundary. Lifting retires that marker, so a fresh
                    // half-open query would silently lose that target. Reach
                    // into its unchanged body for planning, then retain the
                    // user's original selection rather than the planning range.
                    let mut target = local;
                    if owns_endpoint {
                        target.end = DisplayOffset(staged.grapheme_stop(
                            local.end.0,
                            crate::CaretDirection::Forward,
                            false,
                        )?);
                    }
                    let formats = staged.pending_formats.clone();
                    let affinity = staged.affinity;
                    let Some(mut change) = staged.lf_block_command_toggling(
                        staged.revision(),
                        target,
                        command,
                        false,
                        accept,
                    )?
                    else {
                        return Ok(Some(lifted));
                    };
                    if target != local {
                        let selection = DisplayRange {
                            start: change.selection.start,
                            end: DisplayOffset(
                                change.selection.end.0 - (target.end.0 - local.end.0),
                            ),
                        };
                        staged.select_with_affinity(staged.revision(), selection, affinity)?;
                        change.selection = selection;
                        staged.carry_block_state(&mut change, formats, affinity);
                    }
                    accumulate_planning_work(&mut change.work, lifted.work);
                    Ok(Some(change))
                },
            );
        }
        if !lines.iter().any(|line| changes_block(line, command)) {
            return Ok(None);
        }
        let (boundaries, inspected) = self.block_command_boundaries(range, &lines, command);
        let (has_seams, seam_work) = self
            .projection
            .has_block_seams_at_with_work(range, &boundaries);
        let inspected = inspected + seam_work;
        let counted = |result: Result<Option<ViewChange>, EditorError>| {
            result.map(|change| {
                change.map(|mut change| {
                    change.work.link_metadata_items += inspected;
                    change
                })
            })
        };
        if has_seams
            || self
                .projection
                .has_multiline_block_code(&self.source, range)
        {
            return counted(self.stage_block_action(
                expected,
                range,
                None,
                accept,
                |staged, local, accept| {
                    let base = range.start.0 - local.start.0;
                    let boundaries: Vec<_> =
                        boundaries.iter().map(|boundary| boundary - base).collect();
                    let seams = staged.split_inline_block_seams_at(local, &boundaries, accept)?;
                    let Some(mut change) = staged.lf_block_command_toggling(
                        staged.revision(),
                        local,
                        command,
                        false,
                        accept,
                    )?
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
            ));
        }
        if command == BlockCommand::Divider {
            return counted(self.insert_divider(expected, range, lines, accept));
        }
        if matches!(command, BlockCommand::Quote | BlockCommand::Outdent) {
            return counted(self.quote_command(expected, range, command, accept));
        }
        counted(self.apply_block_prefix_command(expected, range, command, lines, accept))
    }

    fn block_command_boundaries(
        &self,
        range: DisplayRange,
        selected: &[crate::inline::blocks::BlockLine],
        command: BlockCommand,
    ) -> (Vec<usize>, usize) {
        let inspected = std::cell::Cell::new(0usize);
        let shape = |line: &crate::inline::blocks::BlockLine| {
            let mut heading = line.heading;
            let mut depth = line.quote_depth;
            if changes_block(line, command)
                && selected
                    .binary_search_by(|selected| {
                        inspected.set(inspected.get() + 1);
                        selected.source.start.cmp(&line.source.start)
                    })
                    .is_ok()
            {
                match command {
                    BlockCommand::Heading(level) => heading = level,
                    BlockCommand::Quote => {
                        heading = 0;
                        if depth == 0 {
                            depth = 1;
                        }
                    }
                    BlockCommand::Outdent => depth -= 1,
                    BlockCommand::Indent
                    | BlockCommand::Divider
                    | BlockCommand::CodeBlock
                    | BlockCommand::WrapCodeBlock
                    | BlockCommand::ToggleHeading(_)
                    | BlockCommand::ToggleTask
                    | BlockCommand::BulletList
                    | BlockCommand::OrderedList
                    | BlockCommand::TaskList => {}
                }
            }
            (heading, depth)
        };
        let boundaries = self
            .projection
            .line_boundaries(range)
            .into_iter()
            .filter(|&boundary| {
                if boundary == 0 {
                    return true;
                }
                let at = |offset| {
                    self.projection
                        .block_lines(DisplayRange {
                            start: DisplayOffset(offset),
                            end: DisplayOffset(offset),
                        })
                        .into_iter()
                        .next()
                };
                let (Some(left), Some(right)) = (at(boundary - 1), at(boundary)) else {
                    return false;
                };
                let (left_heading, left_depth) = shape(&left);
                let (right_heading, right_depth) = shape(&right);
                command == BlockCommand::Divider
                    || left_heading > 0
                    || right_heading > 0
                    || left_depth != right_depth
            })
            .collect();
        (boundaries, inspected.get())
    }
}

fn changes_block(line: &crate::inline::blocks::BlockLine, command: BlockCommand) -> bool {
    if line.code {
        return false;
    }
    if line.divider {
        return command == BlockCommand::Divider;
    }
    match command {
        BlockCommand::Heading(level) => line.heading != level,
        BlockCommand::Quote => line.quote_depth == 0 || line.heading > 0,
        BlockCommand::Outdent => line.quote_depth > 0,
        BlockCommand::Divider | BlockCommand::CodeBlock => true,
        BlockCommand::Indent | BlockCommand::WrapCodeBlock | BlockCommand::ToggleHeading(_) => {
            unreachable!("toolbar commands are resolved before planning")
        }
        BlockCommand::ToggleTask
        | BlockCommand::BulletList
        | BlockCommand::OrderedList
        | BlockCommand::TaskList => false,
    }
}

fn folded_offset(text: &str, offset: usize) -> usize {
    let mut size = 0;
    let mut cr = false;
    for ch in text[..offset].chars() {
        if ch != '\n' || !cr {
            size += if matches!(ch, '\r' | '\n') {
                1
            } else {
                ch.len_utf8()
            };
        }
        cr = ch == '\r';
    }
    size
}
