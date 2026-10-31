use super::*;
use std::collections::HashMap;

impl EditorSession {
    pub(super) fn scoped_list_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        scope: LiftScope,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let mut lines = self.selected_list_lines(range);
        let targets = super::super::list_targets::ListTargets::new(
            &lines,
            command,
            scope == LiftScope::AllAncestors,
        );
        for item in targets.retired_items() {
            let selected = DisplayRange {
                start: DisplayOffset(self.projection.display_at(item.start)),
                end: DisplayOffset(self.projection.display_at(item.end)),
            };
            lines.extend(
                self.projection
                    .list_command_lines(selected)
                    .into_iter()
                    .filter(|line| {
                        !line.code && line.list.as_ref().is_some_and(|list| list.item == *item)
                    }),
            );
        }
        for owner in targets.changed_owners() {
            let group = DisplayRange {
                start: DisplayOffset(self.projection.display_at(owner.start)),
                end: DisplayOffset(self.projection.display_at(owner.end)),
            };
            lines.extend(
                self.projection
                    .list_command_lines(group)
                    .into_iter()
                    .filter(|line| {
                        !line.code
                            && line
                                .list
                                .as_ref()
                                .is_some_and(|list| list.first && list.owner == *owner)
                    }),
            );
        }
        lines.retain(|line| targets.applies(line));
        lines.sort_by_key(|line| {
            crate::inline::visit_container();
            line.source.start
        });
        lines.dedup_by_key(|line| {
            crate::inline::visit_container();
            line.source.start
        });
        let remove = lines.iter().all(|line| targets.removes(line));
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
                    let Some(mut change) = staged.scoped_list_command(
                        staged.revision(),
                        local,
                        command,
                        scope,
                        accept,
                    )?
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
        if remove
            && scope == LiftScope::AllAncestors
            && lines
                .first()
                .and_then(|line| line.list.as_ref())
                .is_some_and(|list| list.outer_depth > 1)
        {
            return self.lift_crossquote_list(expected, range, &lines, accept);
        }
        if remove
            && scope == LiftScope::AllAncestors
            && lines
                .first()
                .and_then(|line| line.list.as_ref())
                .is_some_and(|list| list.parent_marker.is_some() || targets.covered_descendants)
        {
            return self.lift_nested_list(expected, range, &lines, accept);
        }
        let styles = (!remove).then(|| self.list_styles(&lines, command, &targets));
        let lift_plan = if !remove && scope == LiftScope::AllAncestors {
            self.mixed_lift_plan(&lines, command, &targets, styles.as_ref().unwrap())?
        } else {
            super::super::list_lift_plan::MixedLiftPlan::default()
        };
        let start = lines.first().unwrap().source.start;
        let owned_end = if remove {
            0
        } else {
            lines
                .iter()
                .filter(|line| !targets.removes(line))
                .filter_map(|line| line.list.as_ref())
                .map(|list| list.item.end)
                .max()
                .unwrap_or(0)
        };
        let end = lines.last().unwrap().source.end.max(owned_end).max(
            styles
                .as_ref()
                .and_then(|styles| styles.comments.iter().map(|(at, _)| *at).max())
                .unwrap_or(0),
        );
        let output = self.source.byte_slice(start..end).to_string();
        let mut replacements: Vec<_> = styles
            .as_ref()
            .map(|styles| {
                styles
                    .comments
                    .iter()
                    .map(|(at, text)| (at - start..at - start, text.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut parsed = lift_plan.parsed;
        let mut materialized = output.len() + lift_plan.materialized;
        let mut head_prefixes = HashMap::new();
        let mut owned_shifts = Vec::new();
        let mut selection = range;
        let at_source = |at| {
            let point = DisplayOffset(self.projection.display_at(at));
            self.projection
                .list_command_lines(DisplayRange {
                    start: point,
                    end: point,
                })
                .into_iter()
                .next()
        };
        let mut separators = Vec::new();
        let mixed = !remove;
        for (index, line) in lines.iter().enumerate() {
            let remove =
                targets.removes(line) || lift_plan.promoted_ancestors.contains(&line.source.start);
            if line.heading > 0 {
                // ATX closing hashes and a setext underline belong to the
                // retired heading; retain its final physical line ending.
                let raw = self.source.byte_slice(line.source.clone()).to_string();
                let end = line.source.start + raw.trim_end_matches(['\r', '\n']).len();
                replacements.push((line.content.end - start..end - start, String::new()));
                materialized += raw.len();
            }
            let body = self.source.byte_slice(line.content.clone()).to_string();
            let (body, work) = if remove {
                super::super::content::protect_content(&body, false, true)
            } else {
                protect_list_body(&body, command == BlockCommand::TaskList)
            };
            parsed += work;
            materialized += line.content.len() + body.len();
            replacements.push((line.content.start - start..line.content.end - start, body));
            let prefix = self
                .source
                .byte_slice(line.source.start..line.content.start)
                .to_string();
            materialized += prefix.len();
            let retained = if !remove && line.list.is_some() {
                let list = line.list.as_ref().unwrap();
                list.marker.start - line.source.start
            } else if !remove {
                super::super::indent_source::canonical_quote_end(
                    &prefix,
                    styles.as_ref().unwrap().quotes[index],
                )
                .unwrap_or(0)
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
                    BlockCommand::OrderedList => format!(
                        "{}{} ",
                        super::super::lists::physical_number(
                            styles.as_ref().unwrap().ordinals[index]
                        ),
                        styles.as_ref().unwrap().markers[index] as char
                    ),
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
                        format!(
                            "{} [{checked}] ",
                            styles.as_ref().unwrap().markers[index] as char
                        )
                    }
                    _ => format!("{} ", styles.as_ref().unwrap().markers[index] as char),
                }
            };
            let mut replacement = format!("{}{marker}", &prefix[..retained]);
            if remove {
                if let Some(list) = &line.list {
                    let index = self.source.byte_to_line(line.source.start);
                    if index > 0 {
                        let previous = self.source.line_to_byte(index - 1);
                        if self
                            .source
                            .byte_slice(previous..line.source.start)
                            .chars()
                            .any(|ch| {
                                crate::inline::visit_container();
                                !ch.is_whitespace()
                            })
                            && at_source(previous).and_then(|line| line.list).is_some_and(
                                |previous| {
                                    !targets.retires_item(&previous)
                                        && (previous.owner == list.owner
                                            || mixed
                                                && previous.quote_depth == list.quote_depth
                                                && lift_plan.depth_for(&previous, &targets)
                                                    == if lift_plan
                                                        .paragraph_heads
                                                        .contains(&line.source.start)
                                                    {
                                                        1
                                                    } else {
                                                        targets.output_depth(list)
                                                    })
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
                                && !targets.retires_item(&next)
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
            if remove && mixed {
                if let Some(list) = line.list.as_ref().filter(|list| list.first) {
                    // Removing the item also removes its owned indentation
                    // contribution from every continuation/descendant prefix.
                    // Retargeted descendant markers join this same sweep.
                    let delta = list.marker_column as isize - list.content_column as isize;
                    owned_shifts.push(super::super::indent_source::OwnedPrefixShift {
                        start: line.source.end,
                        item: list.item.clone(),
                        quote: list.quote_depth,
                        owner_depth: list.depth,
                        delta,
                    });
                }
            } else if !remove {
                if let Some(list) = &line.list {
                    let logical_end =
                        replacement.len() - usize::from(command == BlockCommand::TaskList) * 4;
                    let column = crate::inline::columns(&replacement[..logical_end], 0);
                    let delta = column as isize - list.content_column as isize;
                    if delta != 0 {
                        owned_shifts.push(super::super::indent_source::OwnedPrefixShift {
                            start: line.source.end,
                            item: list.item.clone(),
                            quote: list.quote_depth,
                            owner_depth: list.depth,
                            delta,
                        });
                    }
                }
            }
            head_prefixes.insert(line.source.start, (replacements.len(), remove));
            replacements.push((
                line.source.start - start..line.content.start - start,
                replacement,
            ));
        }
        let shifted_prefixes = self.owned_prefix_shifts(owned_shifts, lift_plan.overrides)?;
        for super::super::indent_source::PhysicalPrefixShift {
            prefix,
            deltas: mut shifts,
        } in shifted_prefixes
        {
            let at = prefix.source.start;
            let existing = head_prefixes.get(&at).copied();
            // Direct removal already strips list columns inside its quote.
            // Earlier quote components still move with promoted outer lists.
            if existing.is_some_and(|(_, removed)| removed) {
                shifts.retain(|quote, _| {
                    crate::inline::visit_container();
                    *quote < prefix.quote_depth
                });
            }
            let existing = existing.map(|(index, _)| index);
            let mut value = if let Some(index) = existing {
                std::mem::take(&mut replacements[index].1)
            } else {
                let value = self.source.byte_slice(prefix.prefix.clone()).to_string();
                materialized += value.len();
                value
            };
            let blank = !prefix.code
                && !prefix.list.as_ref().is_some_and(|list| list.first)
                && self
                    .source
                    .byte_slice(prefix.content.clone())
                    .chars()
                    .all(|ch| {
                        crate::inline::visit_container();
                        matches!(ch, ' ' | '\t' | '\r' | '\n')
                    });
            if blank {
                // An empty body retains its own trailing padding, but an
                // enclosing list still moves the quote markers before it.
                shifts.retain(|quote, _| {
                    crate::inline::visit_container();
                    *quote < prefix.quote_depth
                });
            }
            if !shifts.is_empty() {
                value = super::super::indent_source::shift_prefixes(
                    &value,
                    prefix.quote_depth,
                    &shifts,
                    false,
                )?;
                materialized += value.len();
            }
            if let Some(&marker) = lift_plan.markers.get(&at) {
                crate::inline::visit_container();
                let cut =
                    super::super::indent_source::canonical_quote_end(&value, prefix.quote_depth)
                        .ok_or(EditorError::UnrepresentableFormat)?;
                let marker_end = cut
                    + value[cut..]
                        .bytes()
                        .position(|byte| {
                            crate::inline::visit_container();
                            matches!(byte, b' ' | b'\t')
                        })
                        .unwrap_or(value.len() - cut);
                if marker_end <= cut {
                    return Err(EditorError::UnrepresentableFormat);
                }
                value.replace_range(marker_end - 1..marker_end, &(marker as char).to_string());
                materialized += 1;
            }
            if let Some(index) = existing {
                replacements[index].1 = value;
            } else {
                replacements.push((
                    prefix.prefix.start - start..prefix.prefix.end - start,
                    value,
                ));
            }
        }
        if !remove {
            if let Some((separator, work)) =
                self.list_neighbor_separator(end, styles.as_ref().unwrap().quotes[lines.len() - 1])
            {
                materialized += work;
                replacements.push((end - start..end - start, separator));
                separators.push(self.projection.display_at(end));
            }
        }
        for endpoint in [&mut selection.start.0, &mut selection.end.0] {
            *endpoint += separators.iter().filter(|&&at| at <= *endpoint).count();
        }
        replacements.sort_by_key(|(range, _)| (range.start, range.end));
        let output = super::super::transaction::spell_edits(&output, &replacements)?;
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
        change.work.materialized_source_bytes += materialized;
        Ok(Some(change))
    }
}
