//! Command-local original fragments for a mixed same-quote full lift.
use super::indent_source::OwnedPrefixOverride;
use super::list_styles::ListStylePlan;
use super::list_targets::ListTargets;
use super::*;
use crate::inline::{blocks::ListCommandLine, ListLine};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Default)]
pub(super) struct MixedLiftPlan {
    pub overrides: Vec<OwnedPrefixOverride>,
    markers: HashMap<usize, u8>,
    paragraph_heads: HashSet<usize>,
    promoted_ancestors: HashSet<usize>,
    pub parsed: usize,
    pub materialized: usize,
    depths: HashMap<usize, Vec<(usize, Option<usize>)>>,
    implicit_items: HashMap<usize, std::ops::Range<usize>>,
    implicit_depths: Vec<(usize, usize)>,
    ordered_cuts: HashMap<usize, Vec<(usize, u64, u64)>>,
}

impl MixedLiftPlan {
    pub fn promotes_ancestor(&self, source: usize) -> bool {
        crate::inline::visit_container();
        self.promoted_ancestors.contains(&source)
    }

    pub fn starts_paragraph(&self, source: usize) -> bool {
        crate::inline::visit_container();
        self.paragraph_heads.contains(&source)
    }

    pub fn marker_at(&self, source: usize) -> Option<u8> {
        crate::inline::visit_container();
        self.markers.get(&source).copied()
    }

    /// A following owner copies the original start when a lifted paragraph
    /// splits its earlier retained item. Cuts apply only within that owner.
    pub fn ordered_number(&self, list: &ListLine, planned: u64) -> (u64, bool) {
        crate::inline::visit_container();
        let cut = self.ordered_cuts.get(&list.owner.start).and_then(|cuts| {
            let end = cuts.partition_point(|&(at, _, _)| {
                crate::inline::visit_container();
                at <= list.marker.start
            });
            end.checked_sub(1).map(|index| cuts[index])
        });
        cut.map_or((planned, false), |(at, baseline, start)| {
            (planned - baseline + start, at == list.marker.start)
        })
    }

    pub fn depth_for(&self, list: &ListLine, targets: &ListTargets) -> usize {
        crate::inline::visit_container();
        let cut = self.depths.get(&list.quote_depth).and_then(|events| {
            let end = events.partition_point(|&(at, _)| {
                crate::inline::visit_container();
                at <= list.marker.start
            });
            end.checked_sub(1).and_then(|index| events[index].1)
        });
        cut.map_or_else(
            || {
                let end = self.implicit_depths.partition_point(|&(at, _)| {
                    crate::inline::visit_container();
                    at <= list.marker.start
                });
                let removed = end
                    .checked_sub(1)
                    .map_or(0, |index| self.implicit_depths[index].1);
                targets.output_depth(list).saturating_sub(removed).max(1)
            },
            |cut| list.depth.saturating_sub(cut).max(1),
        )
    }

    fn index_depths(&mut self) {
        let mut implicit = Vec::new();
        for (&marker, item) in &self.implicit_items {
            crate::inline::visit_container();
            implicit.push((marker + 1, 1isize));
            implicit.push((item.end, -1));
        }
        implicit.sort_by_key(|event| {
            crate::inline::visit_container();
            event.0
        });
        let mut removed = 0isize;
        for (at, delta) in implicit {
            crate::inline::visit_container();
            removed += delta;
            self.implicit_depths.push((at, removed as usize));
        }
        let mut events = Vec::new();
        for (index, fragment) in self.overrides.iter().enumerate() {
            crate::inline::visit_container();
            if fragment.start < fragment.item.end {
                events.push((fragment.start, index, true));
                events.push((fragment.item.end, index, false));
            }
        }
        events.sort_by_key(|event| {
            crate::inline::visit_container();
            event.0
        });
        let mut active = BTreeMap::new();
        for (at, index, begins) in events {
            crate::inline::visit_container();
            let fragment = &self.overrides[index];
            let key = (fragment.quote, fragment.rank, index);
            if begins {
                active.insert(key, fragment.through_depth);
            } else {
                active.remove(&key);
            }
            let cut = active
                .range((fragment.quote, 0, 0)..=(fragment.quote, usize::MAX, usize::MAX))
                .next_back()
                .map(|(_, &depth)| depth);
            self.depths
                .entry(fragment.quote)
                .or_default()
                .push((at, cut));
        }
    }
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
        let mut retired_heads: HashMap<usize, Vec<usize>> = HashMap::new();
        for line in lines {
            crate::inline::visit_container();
            if let Some(list) = line
                .list
                .as_ref()
                .filter(|list| list.first && targets.retires_item(list))
            {
                retired_heads
                    .entry(list.quote_depth)
                    .or_default()
                    .push(list.marker.start);
            }
        }
        let mut row_range = 0..0;
        let mut items = Vec::new();
        let mut next_item = 0;
        let mut item_index = HashMap::new();
        let mut owner_starts = HashMap::new();
        // Transient canonical-event indices, not ancestry retained per witness.
        let mut open_items: Vec<usize> = Vec::new();
        for (rank, line) in lines.iter().enumerate() {
            crate::inline::visit_container();
            let Some(selected) = line.list.as_ref().filter(|list| {
                list.first
                    && (list.parent_marker.is_some() || list.outer_depth > 1)
                    && targets.retires_item(list)
            }) else {
                continue;
            };
            if !row_range.contains(&selected.marker.start) {
                let (original, bytes, range) = self
                    .projection
                    .list_items_at(&self.source, selected.marker.start);
                items = original;
                item_index.clear();
                owner_starts.clear();
                for (index, item) in items.iter().enumerate() {
                    crate::inline::visit_container();
                    item_index.insert(item.item.start, index);
                    owner_starts
                        .entry(item.owner.start)
                        .or_insert(item.ordinal.unwrap_or(1));
                }
                row_range = range;
                plan.parsed += bytes;
                plan.materialized += bytes;
                next_item = 0;
                open_items.clear();
            }
            while next_item < items.len() && items[next_item].marker.start <= selected.marker.start
            {
                #[cfg(test)]
                crate::inline::CONTAINER_LIFT_ITEM_SCANS.with(|count| count.set(count.get() + 1));
                crate::inline::visit_container();
                while open_items.last().is_some_and(|&index| {
                    crate::inline::visit_container();
                    items[index].item.end <= items[next_item].marker.start
                }) {
                    open_items.pop();
                }
                open_items.push(next_item);
                next_item += 1;
            }
            // Same-quote full lifting leaves the earlier ancestor item
            // listed, but its following items form a new owner after the
            // lifted paragraph. Locate that exact cut in original events.
            if command == BlockCommand::OrderedList && selected.outer_depth == 1 {
                crate::inline::visit_container();
                if let Some(&parent_index) = item_index.get(&selected.outer_item.start) {
                    let parent = &items[parent_index];
                    let next = items.partition_point(|item| {
                        crate::inline::visit_container();
                        item.marker.start < parent.item.end
                    });
                    if let Some(following) = items
                        .get(next)
                        .filter(|item| item.owner == parent.owner && !targets.retires_item(item))
                    {
                        let head = self
                            .source
                            .line_to_byte(self.source.byte_to_line(following.marker.start));
                        crate::inline::visit_container();
                        if let Some(&index) = styled.get(&head) {
                            let start = owner_starts[&parent.owner.start];
                            plan.ordered_cuts
                                .entry(parent.owner.start)
                                .or_default()
                                .push((following.marker.start, styles.ordinals[index], start));
                        }
                    }
                }
            }
            // A quote crossing promotes the enclosing group's removed item,
            // including its earlier paragraph. Same-quote parents stay listed.
            if selected.outer_depth > 1 {
                let mut crossed = BTreeMap::new();
                for &index in &open_items {
                    let item = &items[index];
                    #[cfg(test)]
                    crate::inline::CONTAINER_LIFT_ITEM_SCANS
                        .with(|count| count.set(count.get() + 1));
                    crate::inline::visit_container();
                    if item.quote_depth != selected.quote_depth
                        && item.item.start <= selected.marker.start
                        && selected.marker.start < item.item.end
                    {
                        crossed.insert(item.quote_depth, item);
                    }
                }
                for parent in crossed.values() {
                    crate::inline::visit_container();
                    if !targets.retires_item(parent) {
                        let head = self
                            .source
                            .line_to_byte(self.source.byte_to_line(parent.marker.start));
                        plan.promoted_ancestors.insert(head);
                        plan.implicit_items
                            .entry(parent.marker.start)
                            .or_insert_with(|| parent.item.clone());
                    }
                }
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
            let first = items.partition_point(|item| {
                crate::inline::visit_container();
                item.marker.start <= selected.marker.start
            });
            let last = items.partition_point(|item| {
                crate::inline::visit_container();
                item.marker.start < selected.outer_item.end
            });
            if first > last {
                return Err(EditorError::UnrepresentableFormat);
            }
            for child in &items[first..last] {
                #[cfg(test)]
                crate::inline::CONTAINER_LIFT_ITEM_SCANS.with(|count| count.set(count.get() + 1));
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
                crate::inline::visit_container();
                let barrier = retired_heads.get(&child.quote_depth).is_some_and(|heads| {
                    let next = heads.partition_point(|&marker| {
                        crate::inline::visit_container();
                        marker <= child.marker.start
                    });
                    heads
                        .get(next)
                        .is_some_and(|&marker| marker < selected.outer_item.end)
                });
                let after_marker = after.as_ref().filter(|_| !barrier).and_then(|neighbor| {
                    let foreign = neighbor.witness.list.as_ref()?;
                    crate::inline::visit_container();
                    if let Some(&index) = styled.get(&neighbor.witness.source.start) {
                        if styles.quotes[index] != child.quote_depth
                            || foreign.depth != selected.outer_depth
                        {
                            return None;
                        }
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
        for cuts in plan.ordered_cuts.values_mut() {
            cuts.sort_by_key(|cut| {
                crate::inline::visit_container();
                cut.0
            });
            for pair in cuts.windows(2) {
                crate::inline::visit_container();
                if pair[0].0 == pair[1].0 && pair[0] != pair[1] {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            cuts.dedup_by_key(|cut| {
                crate::inline::visit_container();
                cut.0
            });
        }
        plan.index_depths();
        Ok(plan)
    }
}
