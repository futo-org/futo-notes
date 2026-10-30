//! List commands touch their selected bodies and retain unrelated source bytes.
use super::*;

impl EditorSession {
    pub(super) fn list_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let mut lines: Vec<_> = self
            .projection
            .block_lines(range)
            .into_iter()
            .filter(|line| !line.code && !line.divider)
            .collect();
        let remove = lines
            .first()
            .and_then(|line| line.list.as_ref())
            .is_some_and(|list| match command {
                BlockCommand::BulletList => list.ordinal.is_none() && list.checked.is_none(),
                BlockCommand::OrderedList => list.ordinal.is_some() && list.checked.is_none(),
                BlockCommand::TaskList => list.checked.is_some(),
                _ => false,
            });
        let owners: Vec<_> = lines
            .iter()
            .filter_map(|line| line.list.as_ref().map(|list| list.owner.clone()))
            .collect();
        for owner in owners.into_iter().filter(|_| !remove) {
            let group = DisplayRange {
                start: DisplayOffset(self.projection.display_at(owner.start)),
                end: DisplayOffset(self.projection.display_at(owner.end)),
            };
            lines.extend(
                self.projection
                    .block_lines(group)
                    .into_iter()
                    .filter(|line| {
                        !line.code
                            && line
                                .list
                                .as_ref()
                                .is_some_and(|list| list.first && list.owner == owner)
                    }),
            );
        }
        lines.retain(|line| line.list.as_ref().is_none_or(|list| list.first));
        lines.sort_by_key(|line| line.source.start);
        lines.dedup_by_key(|line| line.source.start);
        if lines.is_empty() {
            return Ok(None);
        }
        if self.projection.has_block_seams(range)
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
                    let seams = staged.split_inline_block_seams(local, accept)?;
                    let Some(mut change) =
                        staged.list_command(staged.revision(), local, command, accept)?
                    else {
                        return Ok(None);
                    };
                    if let Some(seams) = seams {
                        change.work.materialized_source_bytes +=
                            seams.work.materialized_source_bytes;
                        change.work.parsed_source_bytes += seams.work.parsed_source_bytes;
                    }
                    Ok(Some(change))
                },
            );
        }
        let start = lines.first().unwrap().source.start;
        let end = lines.last().unwrap().source.end;
        let mut output = self.source.byte_slice(start..end).to_string();
        let mut replacements = Vec::new();
        let mut selection = range;
        let selected: Vec<_> = lines
            .iter()
            .filter_map(|line| line.list.as_ref().map(|list| list.marker.start))
            .collect();
        let at_source = |at| {
            let point = DisplayOffset(self.projection.display_at(at));
            self.projection
                .block_lines(DisplayRange {
                    start: point,
                    end: point,
                })
                .into_iter()
                .next()
        };
        let mut separators = Vec::new();
        let mut ordinal = 1u64;
        let mut previous_owner = None;
        for line in &lines {
            let owner = line.list.as_ref().map(|list| list.owner.clone());
            if owner != previous_owner {
                ordinal = 1;
            }
            previous_owner = owner;
            let prefix = self
                .source
                .byte_slice(line.source.start..line.content.start)
                .to_string();
            let retained = if !remove && line.list.is_some() {
                let list = line.list.as_ref().unwrap();
                list.marker.start - line.source.start
            } else {
                prefix.rfind('>').map_or(0, |at| {
                    at + 1
                        + usize::from(matches!(prefix.as_bytes().get(at + 1), Some(b' ' | b'\t')))
                })
            };
            let marker = if remove {
                String::new()
            } else {
                match command {
                    BlockCommand::OrderedList => format!("{ordinal}. "),
                    BlockCommand::TaskList => {
                        let checked = line
                            .task
                            .as_ref()
                            .map(|task| {
                                self.source
                                    .byte_slice(task.start + 1..task.start + 2)
                                    .to_string()
                            })
                            .unwrap_or_else(|| " ".into());
                        format!("- [{checked}] ")
                    }
                    _ => "- ".into(),
                }
            };
            ordinal += 1;
            let mut replacement = format!("{}{marker}", &prefix[..retained]);
            if remove {
                if let Some(list) = &line.list {
                    let index = self.source.byte_to_line(line.source.start);
                    if index > 0 {
                        let previous = self.source.line_to_byte(index - 1);
                        if !self
                            .source
                            .byte_slice(previous..line.source.start)
                            .to_string()
                            .trim()
                            .is_empty()
                            && at_source(previous).and_then(|line| line.list).is_some_and(
                                |previous| {
                                    previous.owner == list.owner
                                        && !selected.contains(&previous.marker.start)
                                },
                            )
                        {
                            replacement
                                .insert_str(0, &format!("{}\n", prefix[..retained].trim_end()));
                            separators.push(self.projection.display_at(line.source.start));
                        }
                    }
                    if line.source.end < self.source.len_bytes() {
                        if let Some(next) = at_source(line.source.end).and_then(|line| line.list) {
                            if next.owner == list.owner
                                && !selected.contains(&next.marker.start)
                                && next.ordinal.is_some()
                                && self
                                    .source
                                    .byte_slice(next.marker.start..next.marker.end - 1)
                                    .to_string()
                                    .parse::<u64>()
                                    .ok()
                                    != Some(1)
                            {
                                replacements.push((
                                    line.source.end - start..line.source.end - start,
                                    format!("{}\n", prefix[..retained].trim_end()),
                                ));
                                separators.push(self.projection.display_at(line.source.end));
                            }
                        }
                    }
                }
            }
            replacements.push((
                line.source.start - start..line.content.start - start,
                replacement,
            ));
        }
        if !remove {
            let last = lines.last().unwrap();
            if let Some(separator) = self.list_neighbor_separator(end, last.quote_depth) {
                replacements.push((end - start..end - start, separator));
                separators.push(self.projection.display_at(end));
            }
        }
        for endpoint in [&mut selection.start.0, &mut selection.end.0] {
            *endpoint += separators.iter().filter(|&&at| at <= *endpoint).count();
        }
        replacements.sort_by_key(|(range, _)| (range.start, range.end));
        for (range, prefix) in replacements.into_iter().rev() {
            output.replace_range(range, &prefix);
        }
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
        Ok(Some(change))
    }
}
