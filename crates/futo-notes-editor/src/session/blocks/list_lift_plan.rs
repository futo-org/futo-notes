//! Command-local original fragments for a mixed same-quote full lift.
use super::indent_source::OwnedPrefixOverride;
use super::list_styles::ListStylePlan;
use super::list_targets::ListTargets;
use super::*;
use crate::inline::blocks::ListCommandLine;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(super) struct MixedLiftPlan {
    pub overrides: Vec<OwnedPrefixOverride>,
    pub markers: HashMap<usize, u8>,
    pub paragraph_heads: HashSet<usize>,
    pub parsed: usize,
    pub materialized: usize,
}

impl EditorSession {
    pub(super) fn mixed_lift_plan(
        &self,
        lines: &[ListCommandLine],
        command: BlockCommand,
        targets: &ListTargets,
        styles: &ListStylePlan,
    ) -> Result<MixedLiftPlan, EditorError> {
        let mut plan = MixedLiftPlan::default();
        let styled: HashMap<_, _> = lines
            .iter()
            .enumerate()
            .map(|(index, line)| {
                crate::inline::visit_container();
                (line.source.start, index)
            })
            .collect();
        let mut row_range = 0..0;
        let mut items = Vec::new();
        for (rank, line) in lines.iter().enumerate() {
            crate::inline::visit_container();
            let Some(selected) = line.list.as_ref().filter(|list| {
                list.first
                    && list.parent_marker.is_some()
                    && list.outer_depth == 1
                    && targets.retires_item(list)
            }) else {
                continue;
            };
            if !row_range.contains(&selected.marker.start) {
                let (original, bytes, range) = self
                    .projection
                    .list_items_at(&self.source, selected.marker.start);
                items = original;
                row_range = range;
                plan.parsed += bytes;
                plan.materialized += bytes;
            }
            let raw = self
                .source
                .byte_slice(line.source.start..line.content.start)
                .to_string();
            plan.materialized += raw.len();
            let quote_end = super::indent_source::canonical_quote_end(&raw, selected.quote_depth)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let base = crate::inline::columns(&raw[..quote_end], 0);
            plan.paragraph_heads.insert(line.source.start);
            plan.overrides.push(OwnedPrefixOverride {
                start: line.source.end,
                item: selected.item.clone(),
                quote: selected.quote_depth,
                through_depth: selected.depth,
                delta: base as isize - selected.content_column as isize,
                rank,
            });
            let after = self.semantic_neighbor(selected.outer_item.end, true, selected.quote_depth);
            let mut tail_end = selected.item.end;
            for child in &items {
                crate::inline::visit_container();
                if child.quote_depth != selected.quote_depth {
                    continue;
                }
                let descendant = selected.item.start <= child.marker.start
                    && child.marker.start < selected.item.end
                    && child.depth == selected.depth + 1;
                let following = tail_end <= child.marker.start
                    && child.marker.start < selected.outer_item.end
                    && child.depth <= selected.depth;
                if !descendant && !following {
                    continue;
                }
                let head = self
                    .source
                    .line_to_byte(self.source.byte_to_line(child.marker.start));
                if following {
                    plan.overrides.push(OwnedPrefixOverride {
                        start: head,
                        item: child.item.clone(),
                        quote: child.quote_depth,
                        through_depth: child.depth - 1,
                        delta: base as isize - child.marker_column as isize,
                        rank,
                    });
                    tail_end = child.item.end;
                }
                if targets.retires_item(child) {
                    continue;
                }
                let after_marker = after.as_ref().and_then(|neighbor| {
                    let foreign = neighbor.witness.list.as_ref()?;
                    crate::inline::visit_container();
                    if let Some(&index) = styled.get(&neighbor.witness.source.start) {
                        if targets.removes(&lines[index]) {
                            return None;
                        }
                        (child.ordinal.is_some() == (command == BlockCommand::OrderedList))
                            .then_some(styles.markers[index])
                    } else {
                        (foreign.depth == selected.outer_depth
                            && foreign.ordinal.is_some() == child.ordinal.is_some())
                        .then_some(neighbor.marker)
                        .flatten()
                    }
                });
                plan.markers.insert(
                    head,
                    super::list_styles::independent_marker(
                        child.ordinal.is_some(),
                        None,
                        after_marker,
                    ),
                );
            }
        }
        Ok(plan)
    }
}
