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
        range: DisplayRange,
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
        if matches!(command, BlockCommand::Heading(level) if level > 6) {
            return Err(EditorError::InvalidRange);
        }
        if self.projection.has_block_seams(range)
            || self
                .projection
                .has_multiline_block_code(&self.source, range)
        {
            return self.stage_block_action(expected, range, accept, |staged, local, accept| {
                let seams = staged.split_inline_block_seams(local, accept)?;
                let Some(mut change) =
                    staged.block_command(staged.revision(), local, command, accept)?
                else {
                    return Ok(None);
                };
                if let Some(seams) = seams {
                    change.work.materialized_source_bytes += seams.work.materialized_source_bytes;
                    change.work.parsed_source_bytes += seams.work.parsed_source_bytes;
                }
                Ok(Some(change))
            });
        }
        let lines = self.projection.block_lines(range);
        if lines.is_empty() {
            return Ok(None);
        }
        if command == BlockCommand::Divider {
            return self.insert_divider(expected, range, lines, accept);
        }
        let first = &lines[0];
        let end = lines.last().unwrap().source.end;
        let start = first.source.start;
        let raw = self.source.byte_slice(start..end).to_string();
        let mut output = raw.clone();
        let mut changed = false;
        let mut parsed = 0;
        for line in lines.iter().rev() {
            if line.code
                || line.divider
                || matches!(command, BlockCommand::Heading(level) if line.heading == level)
            {
                continue;
            }
            if matches!(command, BlockCommand::Indent | BlockCommand::Outdent) {
                if line.quote_depth > 0 {
                    for physical in line.bodies.iter().chain(line.underline.iter()).rev() {
                        let prefix = self
                            .source
                            .byte_slice(physical.source.start..physical.content.start)
                            .to_string();
                        let replacement = shift_quote_prefix(&prefix, line.quote_depth, command);
                        output.replace_range(
                            physical.source.start - start..physical.content.start - start,
                            &replacement,
                        );
                    }
                    changed = true;
                }
                continue;
            }
            let prefix = self
                .source
                .byte_slice(line.source.start..line.content.start)
                .to_string();
            let canonical_prefix;
            let prefix = if prefix.bytes().filter(|ch| *ch == b'>').count() < line.quote_depth {
                canonical_prefix = format!("{}{}", "> ".repeat(line.quote_depth), prefix);
                canonical_prefix.as_str()
            } else {
                prefix.as_str()
            };
            let quote_prefix = if line.heading > 0 {
                // Indentation before an ATX marker is hidden syntax, while the
                // enclosing quote spelling belongs to the retained container.
                let end = prefix.rfind('>').map_or(0, |at| {
                    at + 1
                        + usize::from(matches!(prefix.as_bytes().get(at + 1), Some(b' ' | b'\t')))
                });
                &prefix[..end]
            } else {
                prefix
            };
            let replacement = match command {
                BlockCommand::Heading(level) => format!(
                    "{quote_prefix}{}",
                    if level == 0 {
                        String::new()
                    } else {
                        format!("{} ", "#".repeat(level as usize))
                    }
                ),
                BlockCommand::Quote if line.quote_depth == 0 => format!("> {quote_prefix}"),
                BlockCommand::Quote if line.heading > 0 => quote_prefix.to_owned(),
                _ => continue,
            };
            changed = true;
            // Changing heading level retires only that line's optional ATX closer.
            if matches!(command, BlockCommand::Heading(_))
                || command == BlockCommand::Quote && line.heading > 0
            {
                let content_end = line.source.end
                    - self
                        .source
                        .byte_slice(line.source.clone())
                        .to_string()
                        .len()
                    + self
                        .source
                        .byte_slice(line.source.clone())
                        .to_string()
                        .trim_end_matches(['\r', '\n'])
                        .len();
                output.replace_range(line.content.end - start..content_end - start, "");
            }
            let body = self.source.byte_slice(line.content.clone()).to_string();
            let heading = matches!(command, BlockCommand::Heading(level) if level > 0);
            let paragraph = command == BlockCommand::Heading(0) || command == BlockCommand::Quote;
            let (body, work) =
                super::content::protect_block_content(&body, line, heading, paragraph);
            parsed += work;
            output.replace_range(line.content.start - start..line.content.end - start, &body);
            output.replace_range(
                line.source.start - start..line.content.start - start,
                &replacement,
            );
        }
        if !changed {
            return Ok(None);
        }
        let mut selection = range;
        if (command == BlockCommand::Indent
            || command == BlockCommand::Quote && first.quote_depth == 0)
            && end < self.source.len_bytes()
        {
            let next_display = self.projection.display_at(end);
            let next_range = DisplayRange {
                start: DisplayOffset(next_display),
                end: DisplayOffset(next_display),
            };
            if let Some(next) = self.projection.block_lines(next_range).first() {
                let target_depth = first.quote_depth + 1;
                if !next.content.is_empty()
                    && next.quote_depth < target_depth
                    && next.heading == 0
                    && !next.divider
                    && !next.code
                {
                    output.push_str(&format!("{}\n", "> ".repeat(first.quote_depth).trim_end()));
                }
            }
        }
        if command == BlockCommand::Outdent && first.quote_depth > 0 && first.source.start > 0 {
            let previous_display = self
                .projection
                .display_at(first.source.start)
                .saturating_sub(1);
            let previous_range = DisplayRange {
                start: DisplayOffset(previous_display),
                end: DisplayOffset(previous_display),
            };
            // Query at the preceding newline (ASCII boundary), never inside Unicode text.
            if self
                .projection
                .block_lines(previous_range)
                .first()
                .is_some_and(|previous| previous.quote_depth >= first.quote_depth)
            {
                output.insert_str(
                    0,
                    &format!("{}\n", "> ".repeat(first.quote_depth - 1).trim_end()),
                );
                selection.start.0 += 1;
                selection.end.0 += 1;
            }
        }
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change =
            self.commit_block_edit(expected, start..end, &output, Some(selection), None, accept)?;
        self.carry_block_state(&mut change, formats, affinity);
        change.work.parsed_source_bytes += parsed;
        Ok(Some(change))
    }
}

/// All physical lines of a semantic block use the same quote-depth operation.
fn shift_quote_prefix(prefix: &str, depth: usize, command: BlockCommand) -> String {
    let canonical;
    let prefix = if prefix.bytes().filter(|ch| *ch == b'>').count() < depth {
        canonical = format!("{}{}", "> ".repeat(depth), prefix);
        canonical.as_str()
    } else {
        prefix
    };
    if command == BlockCommand::Indent {
        format!("> {prefix}")
    } else {
        let at = prefix.find('>').unwrap();
        let cut = at + 1 + usize::from(matches!(prefix.as_bytes().get(at + 1), Some(b' ' | b'\t')));
        prefix[cut..].to_owned()
    }
}
