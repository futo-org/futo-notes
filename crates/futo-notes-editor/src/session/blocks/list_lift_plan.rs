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

#[path = "list_lift_plan_builder.rs"]
mod builder;

impl EditorSession {
    pub(super) fn mixed_lift_plan(
        &self,
        lines: &[ListCommandLine],
        command: BlockCommand,
        targets: &ListTargets,
        styles: &ListStylePlan,
    ) -> Result<MixedLiftPlan, EditorError> {
        builder::build(self, lines, command, targets, styles)
    }
}
