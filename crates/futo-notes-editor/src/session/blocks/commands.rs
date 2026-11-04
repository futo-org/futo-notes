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

    pub fn block_command(
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
                    staged.block_command(staged.revision(), local, command, accept)
                },
            );
        }
        self.validate_range(range)?;
        range = self.body_range(range)?;
        if matches!(command, BlockCommand::Heading(level) if level > 6) {
            return Err(EditorError::InvalidRange);
        }
        if command == BlockCommand::CodeBlock {
            return self.code_block_command(expected, range, accept);
        }
        if matches!(command, BlockCommand::Indent | BlockCommand::Outdent)
            && self
                .projection
                .block_lines(range)
                .iter()
                .any(|line| line.code)
        {
            return self.fence_indent(
                expected,
                range,
                command == BlockCommand::Outdent,
                false,
                accept,
            );
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
        if matches!(command, BlockCommand::Indent | BlockCommand::Outdent) {
            if self
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
                return self.indent_list(expected, range, command, accept);
            }
        }
        let lines = self.selected_block_lines(range);
        // Choosing Quote on text that is already quoted takes one level off.
        let command = if command == BlockCommand::Quote && all_quoted(&lines) {
            BlockCommand::Outdent
        } else {
            command
        };
        if matches!(command, BlockCommand::Heading(1..=6) | BlockCommand::Quote)
            && lines.iter().any(|line| {
                !line.code
                    && line.list.is_some()
                    && (command != BlockCommand::Quote || line.quote_depth == 0)
            })
        {
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
                    let Some(mut change) =
                        staged.block_command(staged.revision(), local, command, accept)?
                    else {
                        return Ok(Some(lifted));
                    };
                    accumulate_planning_work(&mut change.work, lifted.work);
                    Ok(Some(change))
                },
            );
        }
        if !lines.iter().any(|line| changes_block(line, command)) {
            return Ok(None);
        }
        let boundaries = self.block_command_boundaries(range, &lines, command);
        if self.projection.has_block_seams_at(range, &boundaries)
            || self
                .projection
                .has_multiline_block_code(&self.source, range)
        {
            return self.stage_block_action(
                expected,
                range,
                None,
                accept,
                |staged, local, accept| {
                    let base = range.start.0 - local.start.0;
                    let boundaries: Vec<_> =
                        boundaries.iter().map(|boundary| boundary - base).collect();
                    let seams = staged.split_inline_block_seams_at(local, &boundaries, accept)?;
                    let Some(mut change) =
                        staged.block_command(staged.revision(), local, command, accept)?
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
        if command == BlockCommand::Divider {
            return self.insert_divider(expected, range, lines, accept);
        }
        if matches!(
            command,
            BlockCommand::Quote | BlockCommand::Indent | BlockCommand::Outdent
        ) {
            return self.quote_command(expected, range, command, accept);
        }
        self.apply_block_prefix_command(expected, range, command, lines, accept)
    }

    fn block_command_boundaries(
        &self,
        range: DisplayRange,
        selected: &[crate::inline::blocks::BlockLine],
        command: BlockCommand,
    ) -> Vec<usize> {
        let shape = |line: &crate::inline::blocks::BlockLine| {
            let mut heading = line.heading;
            let mut depth = line.quote_depth;
            if selected
                .iter()
                .any(|selected| selected.source.start == line.source.start)
                && changes_block(line, command)
            {
                match command {
                    BlockCommand::Heading(level) => heading = level,
                    BlockCommand::Quote => {
                        heading = 0;
                        if depth == 0 {
                            depth = 1;
                        }
                    }
                    BlockCommand::Indent => depth += 1,
                    BlockCommand::Outdent => depth -= 1,
                    BlockCommand::Divider
                    | BlockCommand::CodeBlock
                    | BlockCommand::ToggleTask
                    | BlockCommand::BulletList
                    | BlockCommand::OrderedList
                    | BlockCommand::TaskList => {}
                }
            }
            (heading, depth)
        };
        self.projection
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
            .collect()
    }
}

/// Every selected prose line is a plain quoted paragraph (not a heading or
/// list), and at least one is.
fn all_quoted(lines: &[crate::inline::blocks::BlockLine]) -> bool {
    let mut prose = lines
        .iter()
        .filter(|line| !line.code && !line.divider && !line.metadata)
        .peekable();
    prose.peek().is_some()
        && prose.all(|line| line.quote_depth > 0 && line.heading == 0 && line.list.is_none())
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
        BlockCommand::Indent | BlockCommand::Outdent => line.quote_depth > 0,
        BlockCommand::Divider | BlockCommand::CodeBlock => true,
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
