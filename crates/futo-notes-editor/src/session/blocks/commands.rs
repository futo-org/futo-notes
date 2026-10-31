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
        if command == BlockCommand::CodeBlock {
            return self.code_block_command(expected, range, accept);
        }
        if command == BlockCommand::ToggleTask {
            return self.toggle_task(expected, range, accept);
        }
        if matches!(
            command,
            BlockCommand::BulletList | BlockCommand::OrderedList | BlockCommand::TaskList
        ) || command == BlockCommand::Heading(0)
            && self
                .projection
                .block_lines(range)
                .iter()
                .any(|line| line.list.is_some())
        {
            return self.list_command(expected, range, command, accept);
        }
        let lines = self.projection.block_lines(range);
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
        let first = &lines[0];
        let end = lines.last().unwrap().source.end;
        let start = first.source.start;
        let raw = self.source.byte_slice(start..end).to_string();
        let mut output = raw.clone();
        let mut changed = false;
        let mut parsed = 0;
        let mut link_metadata_items = 0;
        let mut link_copied_bytes = 0;
        let mut materialized = 0;
        let mut folded = Vec::new();
        let mut retained = Vec::<crate::inline::references::RetainedBody>::new();
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
            let prior_len = output.len();
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
            let retained_body = self.source.byte_slice(line.content.clone()).to_string();
            let heading = matches!(command, BlockCommand::Heading(level) if level > 0);
            let paragraph = command == BlockCommand::Heading(0) || command == BlockCommand::Quote;
            let (body, work) = if heading && line.bodies.len() > 1 {
                let body_start = self.projection.display_at(line.content.start);
                let body_end = self.projection.display_at(line.content.end);
                let shown = self
                    .projection
                    .display
                    .byte_slice(body_start..body_end)
                    .to_string();
                let crate::inline::BodySource {
                    guarded_words,
                    text: body,
                    materialized: body_bytes,
                    parsed: work,
                    work: link_work,
                    ..
                } = self.projection.body_source(
                    &self.source,
                    DisplayRange {
                        start: DisplayOffset(body_start),
                        end: DisplayOffset(body_end),
                    },
                    true,
                    self.revision,
                )?;
                if guarded_words.is_some() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                materialized += body_bytes + shown.len();
                link_metadata_items += link_work.items;
                link_copied_bytes += link_work.copied;
                folded.push((body_start, shown));
                let (body, protected) = super::content::protect_content(&body, true, false);
                (body, work + protected)
            } else {
                super::content::protect_block_content(&retained_body, line, heading, paragraph)
            };
            parsed += work;
            output.replace_range(line.content.start - start..line.content.end - start, &body);
            output.replace_range(
                line.source.start - start..line.content.start - start,
                &replacement,
            );
            for witness in &mut retained {
                witness.after.start = witness.after.start + output.len() - prior_len;
                witness.after.end = witness.after.end + output.len() - prior_len;
                link_metadata_items += 1;
            }
            if paragraph && line.heading > 0 && body == retained_body {
                let body_start = line.source.start - start + replacement.len();
                retained.push(crate::inline::references::RetainedBody {
                    before: line.content.clone(),
                    after: body_start..body_start + body.len(),
                });
            }
        }
        if !changed {
            return Ok(None);
        }
        let mut selection = range;
        for endpoint in [&mut selection.start.0, &mut selection.end.0] {
            let original = *endpoint;
            for (start, shown) in &folded {
                if original > *start {
                    let within = (original - start).min(shown.len());
                    *endpoint -= within - folded_offset(shown, within);
                }
            }
        }
        if (command == BlockCommand::Indent
            || command == BlockCommand::Quote && first.quote_depth == 0)
            && end < self.source.len_bytes()
        {
            if let Some(separator) =
                self.quote_neighbor_separator(end, first.quote_depth + 1, !first.content.is_empty())
            {
                output.push_str(&separator);
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
        let (reference_work, reference_bytes) = self.projection.protect_exposed_definitions(
            &self.source,
            self.context.origin.as_ref(),
            start..end,
            &mut output,
            &retained,
        )?;
        parsed += reference_work.parsed;
        link_metadata_items += reference_work.items;
        link_copied_bytes += reference_work.copied;
        materialized += reference_bytes;
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            start..end,
            &output,
            BlockSelection::Display(selection),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        change.work.parsed_source_bytes += parsed;
        change.work.link_metadata_items += link_metadata_items;
        change.work.link_copied_bytes += link_copied_bytes;
        change.work.materialized_source_bytes += materialized;
        Ok(Some(change))
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
