//! Pick a supported marker without changing either neighboring list. When the
//! two ordered delimiters are both occupied, one standard empty comment keeps
//! the chosen list independent (CommonMark 0.31.2, example 308).
use super::list_targets::ListTargets;
use super::*;
use crate::inline::blocks::{BlockLine, ListCommandLine};
use std::collections::{HashMap, HashSet};

pub(super) struct ListStylePlan {
    pub markers: Vec<u8>,
    pub quotes: Vec<usize>,
    pub ordinals: Vec<u64>,
    pub comments: Vec<(usize, String)>,
    pub materialized: usize,
}

/// A command-local resolved fragment, never a retained owner-wide cache.
#[derive(Clone, Copy)]
struct OwnerStyle {
    marker: u8,
    quote: usize,
    depth: usize,
    kind: BlockCommand,
    run: Option<usize>,
    start: usize,
    end: usize,
    after_line: usize,
}

enum ListIntent {
    Independent,
    Shortcut { start: Option<u64> },
}

#[path = "list_styles_builder.rs"]
mod builder;

impl EditorSession {
    pub(super) fn list_styles(
        &self,
        lines: &[ListCommandLine],
        command: BlockCommand,
        targets: &ListTargets,
    ) -> ListStylePlan {
        self.plan_list_styles(lines, command, ListIntent::Independent, Some(targets))
    }

    pub(super) fn list_shortcut_styles(
        &self,
        line: &BlockLine,
        start: Option<u64>,
    ) -> ListStylePlan {
        let line = ListCommandLine::from_block(line, 0);
        self.plan_list_styles(
            std::slice::from_ref(&line),
            if start.is_some() {
                BlockCommand::OrderedList
            } else {
                BlockCommand::BulletList
            },
            ListIntent::Shortcut { start },
            None,
        )
    }

    fn plan_list_styles(
        &self,
        lines: &[ListCommandLine],
        command: BlockCommand,
        intent: ListIntent,
        targets: Option<&ListTargets>,
    ) -> ListStylePlan {
        builder::build(self, lines, command, intent, targets)
    }
}

/// A lifted item joins its actual parent list. Only the touched marker changes;
/// its descendants follow the resulting content column, not a fixed indent.
pub(super) fn lifted_marker(parent: &str, number: Option<u64>) -> String {
    marker_at_number(parent, number.map(|number| number + 1))
}

pub(super) fn nested_marker(current: &str, start: Option<u64>, index: usize) -> String {
    marker_at_number(current, start.map(|number| number + index as u64))
}

fn marker_at_number(marker: &str, number: Option<u64>) -> String {
    match number {
        Some(number) => format!(
            "{}{}",
            super::lists::physical_number(number),
            marker.chars().last().unwrap()
        ),
        None => marker.to_owned(),
    }
}

/// Shared supported-marker choice for newly independent list owners.
pub(super) fn independent_marker(ordered: bool, before: Option<u8>, after: Option<u8>) -> u8 {
    let candidates: &[u8] = if ordered { b".)" } else { b"-+*" };
    candidates
        .iter()
        .copied()
        .find(|&marker| Some(marker) != before && Some(marker) != after)
        .unwrap_or(candidates[0])
}
