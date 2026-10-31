//! Full-list lifting across quotes uses original canonical item fragments.
use super::indent_source::{OwnedPrefixShift, PhysicalPrefixShift};
use super::*;
use crate::inline::{
    blocks::{ListCommandLine, SourcePrefix},
    ListLine,
};
use std::{collections::BTreeMap, ops::Range};

struct Group {
    root: ListLine,
    removed: ListLine,
}

impl EditorSession {
    pub(super) fn lift_crossquote_list(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        lines: &[ListCommandLine],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let selected = lines[0]
            .list
            .as_ref()
            .ok_or(EditorError::UnrepresentableFormat)?;
        let (items, planning_bytes, _) = self
            .projection
            .list_items_at(&self.source, selected.marker.start);
        let mut groups: Vec<Group> = Vec::new();
        for item in &items {
            crate::inline::visit_container();
            if item.item.start <= selected.marker.start && selected.marker.start < item.item.end {
                if let Some(group) = groups
                    .last_mut()
                    .filter(|group| group.root.quote_depth == item.quote_depth)
                {
                    group.removed = item.clone();
                } else {
                    groups.push(Group {
                        root: item.clone(),
                        removed: item.clone(),
                    });
                }
            }
        }
        let mut spans = Vec::new();
        let mut heads: BTreeMap<usize, SourcePrefix> = BTreeMap::new();
        let mut changes: BTreeMap<usize, Vec<(Range<usize>, String)>> = BTreeMap::new();
        let mut bodies: BTreeMap<usize, (Range<usize>, String)> = BTreeMap::new();
        let mut parsed = planning_bytes;
        let mut materialized = planning_bytes;
        for group in &groups {
            crate::inline::visit_container();
            let item = &group.removed;
            let head = self
                .source
                .line_to_byte(self.source.byte_to_line(item.marker.start));
            let prefix = self
                .projection
                .source_prefix_at(head)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let raw = self.source.byte_slice(prefix.prefix.clone()).to_string();
            materialized += raw.len();
            let quote_end = super::indent_source::canonical_quote_end(&raw, item.quote_depth)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let base = crate::inline::columns(&raw[..quote_end], 0);
            let mut retired_end = head + item.indent;
            if item.checked.is_some() {
                retired_end += 3;
                if self
                    .source
                    .byte_slice(retired_end..(retired_end + 1).min(self.source.len_bytes()))
                    .bytes()
                    .next()
                    .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
                {
                    retired_end += 1;
                }
            }
            if retired_end > prefix.prefix.end {
                return Err(EditorError::UnrepresentableFormat);
            }
            changes
                .entry(head)
                .or_default()
                .push((item.marker.start..retired_end, String::new()));
            let delta = base as isize - item.marker_column as isize;
            if delta != 0 {
                spans.push(OwnedPrefixShift {
                    start: head,
                    item: prefix.source.clone(),
                    quote: item.quote_depth,
                    owner_depth: item.depth,
                    delta,
                });
            }
            let delta = base as isize - item.content_column as isize;
            if delta != 0 {
                spans.push(OwnedPrefixShift {
                    start: prefix.source.end,
                    item: item.item.clone(),
                    quote: item.quote_depth,
                    owner_depth: item.depth,
                    delta,
                });
            }
            if !prefix.code {
                let raw_body = self.source.byte_slice(prefix.content.clone()).to_string();
                let (protected, work) = super::content::protect_content(&raw_body, false, true);
                parsed += work;
                materialized += raw_body.len() + protected.len();
                if protected != raw_body {
                    let before = raw_body
                        .chars()
                        .zip(protected.chars())
                        .take_while(|(a, b)| a == b)
                        .map(|(ch, _)| ch.len_utf8())
                        .sum::<usize>();
                    let after = raw_body[before..]
                        .chars()
                        .rev()
                        .zip(protected[before..].chars().rev())
                        .take_while(|(a, b)| a == b)
                        .map(|(ch, _)| ch.len_utf8())
                        .sum::<usize>();
                    bodies.insert(
                        prefix.content.start,
                        (
                            prefix.content.start + before..prefix.content.end - after,
                            protected[before..protected.len() - after].to_owned(),
                        ),
                    );
                }
            }
            let after = self
                .semantic_neighbor(group.root.item.end, true, item.quote_depth)
                .filter(|neighbor| {
                    neighbor
                        .witness
                        .list
                        .as_ref()
                        .is_some_and(|list| list.depth == group.root.depth)
                });
            let mut tail_end = item.item.end;
            for child in &items {
                crate::inline::visit_container();
                if child.quote_depth != item.quote_depth {
                    continue;
                }
                let descendant = item.item.start <= child.marker.start
                    && child.marker.start < item.item.end
                    && child.depth == item.depth + 1;
                let following = group.root.item != item.item
                    && tail_end <= child.marker.start
                    && child.marker.start < group.root.item.end
                    && child.depth <= item.depth;
                if !descendant && !following {
                    continue;
                }
                let child_head = self
                    .source
                    .line_to_byte(self.source.byte_to_line(child.marker.start));
                let child_prefix = self
                    .projection
                    .source_prefix_at(child_head)
                    .ok_or(EditorError::UnrepresentableFormat)?;
                if following {
                    let spelling = self
                        .source
                        .byte_slice(child_prefix.prefix.clone())
                        .to_string();
                    materialized += spelling.len();
                    let quote =
                        super::indent_source::canonical_quote_end(&spelling, child.quote_depth)
                            .ok_or(EditorError::UnrepresentableFormat)?;
                    let column = crate::inline::columns(&spelling[..quote], 0);
                    spans.push(OwnedPrefixShift {
                        start: child_head,
                        item: child.item.clone(),
                        quote: child.quote_depth,
                        owner_depth: child.depth,
                        delta: column as isize - child.marker_column as isize,
                    });
                    tail_end = child.item.end;
                }
                let after_marker = after
                    .as_ref()
                    .filter(|neighbor| {
                        neighbor.witness.list.as_ref().is_some_and(|foreign| {
                            foreign.ordinal.is_some() == child.ordinal.is_some()
                        })
                    })
                    .and_then(|neighbor| neighbor.marker);
                let marker = super::list_styles::independent_marker(
                    child.ordinal.is_some(),
                    None,
                    after_marker,
                );
                changes.entry(child_head).or_default().push((
                    child.marker.end - 1..child.marker.end,
                    (marker as char).to_string(),
                ));
                heads.entry(child_head).or_insert(child_prefix);
            }
            heads.entry(head).or_insert(prefix);
        }
        let mut physical: BTreeMap<usize, PhysicalPrefixShift> = self
            .owned_prefix_shifts(spans, Vec::new())?
            .into_iter()
            .map(|plan| (plan.prefix.source.start, plan))
            .collect();
        for (at, prefix) in heads {
            physical.entry(at).or_insert(PhysicalPrefixShift {
                prefix,
                deltas: BTreeMap::new(),
            });
        }
        let mut edits = Vec::new();
        for (
            at,
            PhysicalPrefixShift {
                prefix,
                deltas: mut shifts,
            },
        ) in physical
        {
            crate::inline::visit_container();
            let raw = self.source.byte_slice(prefix.prefix.clone()).to_string();
            materialized += raw.len();
            let mut parts = changes.remove(&at).unwrap_or_default();
            parts.sort_by_key(|(range, _)| range.start);
            let relative: Vec<_> = parts
                .into_iter()
                .map(|(range, text)| {
                    (
                        range.start - prefix.prefix.start..range.end - prefix.prefix.start,
                        text,
                    )
                })
                .collect();
            let mut value = super::transaction::spell_edits(&raw, &relative)?;
            materialized += value.len();
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
                shifts.retain(|quote, _| {
                    crate::inline::visit_container();
                    *quote < prefix.quote_depth
                });
            }
            if !shifts.is_empty() {
                value = super::indent_source::shift_prefixes(
                    &value,
                    prefix.quote_depth,
                    &shifts,
                    false,
                )?;
                materialized += value.len();
            }
            if value != raw {
                edits.push((prefix.prefix, value));
            }
        }
        edits.extend(bodies.into_values());
        edits.sort_by_key(|(range, _)| range.start);
        let Some(first) = edits.first() else {
            return Ok(None);
        };
        let footprint = first.0.start..edits.last().unwrap().0.end;
        let original = self.source.byte_slice(footprint.clone()).to_string();
        materialized += original.len();
        let relative: Vec<_> = edits
            .iter()
            .map(|(range, text)| {
                (
                    range.start - footprint.start..range.end - footprint.start,
                    text.clone(),
                )
            })
            .collect();
        materialized += relative.iter().map(|(_, text)| text.len()).sum::<usize>();
        let output = super::transaction::spell_edits(&original, &relative)?;
        let map = |point: usize| -> Result<usize, EditorError> {
            let original = self.projection.source_bounds(point).1;
            let mut shift = 0isize;
            for (range, text) in &edits {
                crate::inline::visit_container();
                if original >= range.end {
                    shift += text.len() as isize - range.len() as isize;
                } else if original > range.start {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            original
                .checked_add_signed(shift)
                .ok_or(EditorError::UnrepresentableFormat)
        };
        let selected = map(range.start.0)?..map(range.end.0)?;
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            footprint,
            &output,
            BlockSelection::SourceRange(selected),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        change.work.parsed_source_bytes += parsed;
        change.work.materialized_source_bytes += materialized;
        Ok(Some(change))
    }
}

#[cfg(test)]
#[path = "list_lift_crossquote_work.rs"]
mod work_tests;
