//! Command-local canonical-row cursor and original mixed-fragment planning.
use super::super::indent_source;
use super::*;
use crate::session::staging::Neighbor;

/// Existing transient event indices for one true row, never witness ancestry.
#[derive(Default)]
struct RowItems {
    row_range: std::ops::Range<usize>,
    items: Vec<ListLine>,
    next_item: usize,
    item_index: HashMap<usize, usize>,
    owner_starts: HashMap<usize, u64>,
    open_items: Vec<usize>,
}
impl RowItems {
    fn seek(&mut self, session: &EditorSession, selected: &ListLine) -> usize {
        let mut loaded = 0;
        if !self.row_range.contains(&selected.marker.start) {
            let (original, bytes, range) = session
                .projection
                .list_items_at(&session.source, selected.marker.start);
            self.items = original;
            self.item_index.clear();
            self.owner_starts.clear();
            for (index, item) in self.items.iter().enumerate() {
                crate::inline::visit_container();
                self.item_index.insert(item.item.start, index);
                self.owner_starts
                    .entry(item.owner.start)
                    .or_insert(item.ordinal.unwrap_or(1));
            }
            self.row_range = range;
            loaded = bytes;
            self.next_item = 0;
            self.open_items.clear();
        }
        while self.next_item < self.items.len()
            && self.items[self.next_item].marker.start <= selected.marker.start
        {
            #[cfg(test)]
            crate::inline::CONTAINER_LIFT_ITEM_SCANS.with(|count| count.set(count.get() + 1));
            crate::inline::visit_container();
            while self.open_items.last().is_some_and(|&index| {
                crate::inline::visit_container();
                self.items[index].item.end <= self.items[self.next_item].marker.start
            }) {
                self.open_items.pop();
            }
            self.open_items.push(self.next_item);
            self.next_item += 1;
        }
        loaded
    }
}

struct MixedPlanner<'a> {
    session: &'a EditorSession,
    lines: &'a [ListCommandLine],
    command: BlockCommand,
    targets: &'a ListTargets,
    styles: &'a ListStylePlan,
    styled: HashMap<usize, usize>,
    retired_heads: HashMap<usize, Vec<usize>>,
    cursor: RowItems,
    plan: MixedLiftPlan,
}

pub(super) fn build(
    session: &EditorSession,
    lines: &[ListCommandLine],
    command: BlockCommand,
    targets: &ListTargets,
    styles: &ListStylePlan,
) -> Result<MixedLiftPlan, EditorError> {
    let plan = MixedLiftPlan::default();
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
    let mut planner = MixedPlanner {
        session,
        lines,
        command,
        targets,
        styles,
        styled,
        retired_heads,
        cursor: RowItems::default(),
        plan,
    };
    for (rank, line) in lines.iter().enumerate() {
        planner.visit(rank, line)?;
    }
    planner.finish()
}

impl MixedPlanner<'_> {
    fn visit(&mut self, rank: usize, line: &ListCommandLine) -> Result<(), EditorError> {
        crate::inline::visit_container();
        let Some(selected) = line.list.as_ref().filter(|list| {
            list.first
                && (list.parent_marker.is_some() || list.outer_depth > 1)
                && self.targets.retires_item(list)
        }) else {
            return Ok(());
        };
        let loaded = self.cursor.seek(self.session, selected);
        self.plan.parsed += loaded;
        self.plan.materialized += loaded;
        self.record_ordered_following(selected);
        self.promote_crossed_ancestors(selected);
        self.plan_descendant_fragments(rank, line, selected)
    }

    fn record_ordered_following(&mut self, selected: &ListLine) {
        // Same-quote full lifting leaves the earlier ancestor item
        // listed, but its following items form a new owner after the
        // lifted paragraph. Locate that exact cut in original events.
        if self.command == BlockCommand::OrderedList && selected.outer_depth == 1 {
            crate::inline::visit_container();
            if let Some(&parent_index) = self.cursor.item_index.get(&selected.outer_item.start) {
                let parent = &self.cursor.items[parent_index];
                let next = self.cursor.items.partition_point(|item| {
                    crate::inline::visit_container();
                    item.marker.start < parent.item.end
                });
                if let Some(following) =
                    self.cursor.items.get(next).filter(|item| {
                        item.owner == parent.owner && !self.targets.retires_item(item)
                    })
                {
                    let head = self
                        .session
                        .source
                        .line_to_byte(self.session.source.byte_to_line(following.marker.start));
                    crate::inline::visit_container();
                    if let Some(&index) = self.styled.get(&head) {
                        let start = self.cursor.owner_starts[&parent.owner.start];
                        self.plan
                            .ordered_cuts
                            .entry(parent.owner.start)
                            .or_default()
                            .push((following.marker.start, self.styles.ordinals[index], start));
                    }
                }
            }
        }
    }

    fn promote_crossed_ancestors(&mut self, selected: &ListLine) {
        // A quote crossing promotes the enclosing group's removed item,
        // including its earlier paragraph. Same-quote parents stay listed.
        if selected.outer_depth > 1 {
            let mut crossed = BTreeMap::new();
            for &index in &self.cursor.open_items {
                let item = &self.cursor.items[index];
                #[cfg(test)]
                crate::inline::CONTAINER_LIFT_ITEM_SCANS.with(|count| count.set(count.get() + 1));
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
                if !self.targets.retires_item(parent) {
                    let head = self
                        .session
                        .source
                        .line_to_byte(self.session.source.byte_to_line(parent.marker.start));
                    self.plan.promoted_ancestors.insert(head);
                    self.plan
                        .implicit_items
                        .entry(parent.marker.start)
                        .or_insert_with(|| parent.item.clone());
                }
            }
        }
    }

    fn plan_descendant_fragments(
        &mut self,
        rank: usize,
        line: &ListCommandLine,
        selected: &ListLine,
    ) -> Result<(), EditorError> {
        let raw = self
            .session
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        self.plan.materialized += raw.len();
        let quote_end = indent_source::canonical_quote_end(&raw, selected.quote_depth)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let base = crate::inline::columns(&raw[..quote_end], 0);
        self.plan.paragraph_heads.insert(line.source.start);
        self.plan.overrides.push(OwnedPrefixOverride {
            start: line.source.end,
            item: selected.item.clone(),
            quote: selected.quote_depth,
            through_depth: selected.depth,
            delta: base as isize - selected.content_column as isize,
            rank,
        });
        let after =
            self.session
                .semantic_neighbor(selected.outer_item.end, true, selected.quote_depth);
        let mut tail_end = selected.item.end;
        let first = self.cursor.items.partition_point(|item| {
            crate::inline::visit_container();
            item.marker.start <= selected.marker.start
        });
        let last = self.cursor.items.partition_point(|item| {
            crate::inline::visit_container();
            item.marker.start < selected.outer_item.end
        });
        if first > last {
            return Err(EditorError::UnrepresentableFormat);
        }
        for child in &self.cursor.items[first..last] {
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
                .session
                .source
                .line_to_byte(self.session.source.byte_to_line(child.marker.start));
            if following {
                self.plan.overrides.push(OwnedPrefixOverride {
                    start: head,
                    item: child.item.clone(),
                    quote: child.quote_depth,
                    through_depth: child.depth - 1,
                    delta: base as isize - child.marker_column as isize,
                    rank,
                });
                tail_end = child.item.end;
            }
            if self.targets.retires_item(child) {
                continue;
            }
            let after_marker = self.fragment_after_marker(child, selected, after.as_ref());
            self.plan.markers.insert(
                head,
                super::list_styles::independent_marker(child.ordinal.is_some(), None, after_marker),
            );
        }
        Ok(())
    }

    fn fragment_after_marker(
        &self,
        child: &ListLine,
        selected: &ListLine,
        after: Option<&Neighbor>,
    ) -> Option<u8> {
        crate::inline::visit_container();
        let barrier = self
            .retired_heads
            .get(&child.quote_depth)
            .is_some_and(|heads| {
                let next = heads.partition_point(|&marker| {
                    crate::inline::visit_container();
                    marker <= child.marker.start
                });
                heads
                    .get(next)
                    .is_some_and(|&marker| marker < selected.outer_item.end)
            });
        let after_marker = after.filter(|_| !barrier).and_then(|neighbor| {
            let foreign = neighbor.witness.list.as_ref()?;
            crate::inline::visit_container();
            if let Some(&index) = self.styled.get(&neighbor.witness.source.start) {
                if self.styles.quotes[index] != child.quote_depth
                    || foreign.depth != selected.outer_depth
                {
                    return None;
                }
                if self.targets.removes(&self.lines[index]) {
                    return None;
                }
                (child.ordinal.is_some() == (self.command == BlockCommand::OrderedList))
                    .then_some(self.styles.markers[index])
            } else {
                (foreign.depth == selected.outer_depth
                    && foreign.ordinal.is_some() == child.ordinal.is_some())
                .then_some(neighbor.marker)
                .flatten()
            }
        });
        after_marker
    }

    fn finish(mut self) -> Result<MixedLiftPlan, EditorError> {
        for cuts in self.plan.ordered_cuts.values_mut() {
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
        self.plan.index_depths();
        Ok(self.plan)
    }
}
