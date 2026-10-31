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
}

enum ListIntent {
    Independent,
    Shortcut { start: Option<u64> },
}

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
        let ordered = command == BlockCommand::OrderedList;
        let candidates: &[u8] = if ordered { b".)" } else { b"-+*" };
        let planned_owners: HashSet<_> = lines
            .iter()
            .filter(|line| targets.is_none_or(|targets| !targets.removes(line)))
            .filter_map(|line| line.list.as_ref().map(|list| list.owner.start))
            .collect();
        let mut resolved_owners = HashMap::new();
        let mut resolved_lines = HashMap::new();
        let mut owner_ordinals: HashMap<usize, u64> = HashMap::new();
        let mut result = ListStylePlan {
            markers: vec![candidates[0]; lines.len()],
            ordinals: vec![1; lines.len()],
            quotes: lines
                .iter()
                .map(|line| {
                    crate::inline::visit_container();
                    if matches!(intent, ListIntent::Independent)
                        && line.list.is_none()
                        && line.heading == 0
                    {
                        0
                    } else {
                        line.quote_depth
                    }
                })
                .collect(),
            comments: Vec::new(),
        };
        let mut first = 0;
        while first < lines.len() {
            if targets.is_some_and(|targets| targets.removes(&lines[first])) {
                // A retired item is a paragraph barrier. A later fragment of
                // this original owner starts its own ordered sequence.
                if let Some(list) = &lines[first].list {
                    crate::inline::visit_container();
                    owner_ordinals.remove(&list.owner.start);
                }
                first += 1;
                continue;
            }
            let owner = lines[first].list.as_ref().map(|list| list.owner.clone());
            let mut last = first + 1;
            while last < lines.len()
                && targets.is_none_or(|targets| !targets.removes(&lines[last]))
                && lines[last].list.as_ref().map(|list| list.owner.clone()) == owner
                && (owner.is_some()
                    || targets.is_none_or(|targets| {
                        targets.run(&lines[first]) == targets.run(&lines[last])
                    }))
            {
                last += 1;
            }
            let head = &lines[first];
            let quote_depth = result.quotes[first];
            let tail = &lines[last - 1];
            let depth = head.list.as_ref().map_or(1, |list| {
                targets.map_or(list.depth, |targets| targets.output_depth(list))
            });
            let before_line = self.source.byte_to_line(head.source.start);
            // Container event endpoints can include a following quote prefix.
            // Walk actual physical item ownership instead of skipping that line.
            let mut after_line = self.source.byte_to_line(tail.source.end.saturating_sub(1)) + 1;
            if let Some(owner) = &owner {
                let mut scan = after_line;
                while scan < self.source.len_lines() {
                    #[cfg(test)]
                    crate::inline::CONTAINER_STYLE_OWNER_SCANS
                        .with(|count| count.set(count.get() + 1));
                    let at = self.source.line_to_byte(scan);
                    let Some(line) = self.projection.list_command_line_at_source(at) else {
                        break;
                    };
                    let belongs = line.list.as_ref().is_some_and(|list| {
                        list.owner == *owner
                            || list.depth > depth
                                && owner.start <= list.marker.start
                                && list.marker.start < owner.end
                    });
                    if !belongs {
                        break;
                    }
                    scan += 1;
                    let blank = self
                        .source
                        .byte_slice(line.content.clone())
                        .chars()
                        .all(|ch| matches!(ch, ' ' | '\t'));
                    if !blank || line.list.as_ref().is_some_and(|list| list.first) {
                        after_line = scan;
                    }
                }
            }
            while after_line > before_line + 1 {
                let at = self.source.line_to_byte(after_line - 1);
                let Some(line) = self.projection.list_command_line_at_source(at) else {
                    break;
                };
                let blank = self
                    .source
                    .byte_slice(line.content.clone())
                    .chars()
                    .all(|ch| matches!(ch, ' ' | '\t'));
                if !blank
                    || line.empty_comment
                    || line.quote_depth != head.quote_depth
                    || line.list.as_ref().is_some_and(|list| list.first)
                {
                    break;
                }
                after_line -= 1;
            }
            let neighbor = |at: usize, forward: bool| {
                let neighbor = self.semantic_neighbor(at, forward, quote_depth)?;
                let line = neighbor.witness;
                if line.empty_comment || line.code {
                    return None;
                }
                if neighbor.local
                    && targets.is_some_and(|targets| {
                        targets.retires(line.source.start, line.list.as_ref())
                    })
                {
                    return None;
                }
                // A planned local paragraph may now be a root list. Resolve its
                // explicit outcome before consulting its original quote scope.
                if neighbor.local && line.list.is_none() {
                    if let Some(&(marker, quote, nested)) = resolved_lines.get(&line.source.start) {
                        return (quote == quote_depth && nested == depth).then_some((marker, None));
                    }
                }
                if line.quote_depth != quote_depth {
                    return None;
                }
                if let Some(list) = &line.list {
                    if let Some(&(marker, quote, nested)) = resolved_owners
                        .get(&list.owner.start)
                        .filter(|_| neighbor.local)
                    {
                        return (quote == quote_depth && nested == depth).then_some((marker, None));
                    }
                    if neighbor.local && planned_owners.contains(&list.owner.start) {
                        return None;
                    }
                    if list.depth != depth {
                        return None;
                    }
                    if list.ordinal.is_some() == ordered {
                        return Some((
                            neighbor.marker.unwrap(),
                            list.ordinal.map(|number| number + 1),
                        ));
                    }
                }
                None
            };
            let preceding = neighbor(head.source.start, false);
            let before = preceding.map(|(marker, _)| marker);
            let after_at = if after_line < self.source.len_lines() {
                self.source.line_to_byte(after_line)
            } else {
                self.source.len_bytes()
            };
            let after = neighbor(after_at, true).map(|(marker, _)| marker);
            // Shipping wrappingInputRule joins only the preceding list. Ordered
            // input must spell its interpreted next number; bullets always join.
            let join = match intent {
                ListIntent::Shortcut { start } => preceding
                    .filter(|(_, next)| start == *next)
                    .map(|(marker, _)| marker),
                ListIntent::Independent => None,
            };
            let marker = join.unwrap_or_else(|| independent_marker(ordered, before, after));
            for index in first..last {
                crate::inline::visit_container();
                result.markers[index] = marker;
                result.ordinals[index] = if let Some(owner) = &owner {
                    // Nested owners can intervene in physical source order;
                    // they must not restart their enclosing owner's sequence.
                    crate::inline::visit_container();
                    let ordinal = owner_ordinals.entry(owner.start).or_default();
                    *ordinal += 1;
                    *ordinal
                } else {
                    (index - first) as u64 + 1
                };
                resolved_lines.insert(
                    lines[index].source.start,
                    (marker, result.quotes[index], depth),
                );
            }
            if let Some(owner) = &owner {
                resolved_owners.insert(owner.start, (marker, quote_depth, depth));
            }
            let prefix = self
                .source
                .byte_slice(head.source.start..head.content.start)
                .to_string();
            let retained = if let Some(list) = &head.list {
                list.marker.start - head.source.start
            } else {
                super::indent_source::canonical_quote_end(&prefix, quote_depth).unwrap_or(0)
            };
            let comment = format!("{}<!-- -->\n", &prefix[..retained]);
            if before == Some(marker) && join.is_none() {
                result.comments.push((head.source.start, comment));
            } else if after == Some(marker) {
                let at = if after_line < self.source.len_lines() {
                    self.source.line_to_byte(after_line)
                } else {
                    self.source.len_bytes()
                };
                result.comments.push((at, comment));
            }
            first = last;
        }
        result
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
