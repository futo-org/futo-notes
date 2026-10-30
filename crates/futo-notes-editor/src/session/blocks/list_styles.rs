//! Pick a supported marker without changing either neighboring list. When the
//! two ordered delimiters are both occupied, one standard empty comment keeps
//! the chosen list independent (CommonMark 0.31.2, example 308).
use super::*;
use crate::inline::blocks::BlockLine;
use std::collections::{HashMap, HashSet};

pub(super) struct ListStylePlan {
    pub markers: Vec<u8>,
    pub comments: Vec<(usize, String)>,
}

enum ListIntent {
    Independent,
    Shortcut { start: Option<u64> },
}

impl EditorSession {
    pub(super) fn list_styles(&self, lines: &[BlockLine], command: BlockCommand) -> ListStylePlan {
        self.plan_list_styles(lines, command, ListIntent::Independent)
    }

    pub(super) fn list_shortcut_styles(
        &self,
        line: &BlockLine,
        start: Option<u64>,
    ) -> ListStylePlan {
        self.plan_list_styles(
            std::slice::from_ref(line),
            if start.is_some() {
                BlockCommand::OrderedList
            } else {
                BlockCommand::BulletList
            },
            ListIntent::Shortcut { start },
        )
    }

    fn plan_list_styles(
        &self,
        lines: &[BlockLine],
        command: BlockCommand,
        intent: ListIntent,
    ) -> ListStylePlan {
        let ordered = command == BlockCommand::OrderedList;
        let candidates: &[u8] = if ordered { b".)" } else { b"-+*" };
        let planned_owners: HashSet<_> = lines
            .iter()
            .filter_map(|line| line.list.as_ref().map(|list| list.owner.start))
            .collect();
        let mut resolved_owners = HashMap::new();
        let mut resolved_lines = HashMap::new();
        let mut result = ListStylePlan {
            markers: vec![candidates[0]; lines.len()],
            comments: Vec::new(),
        };
        let mut first = 0;
        while first < lines.len() {
            let owner = lines[first].list.as_ref().map(|list| list.owner.clone());
            let mut last = first + 1;
            while last < lines.len()
                && lines[last].list.as_ref().map(|list| list.owner.clone()) == owner
            {
                last += 1;
            }
            let head = &lines[first];
            let tail = &lines[last - 1];
            let depth = head.list.as_ref().map_or(1, |list| list.depth);
            let before_line = self.source.byte_to_line(head.source.start);
            // Container event endpoints can include a following quote prefix.
            // Walk actual physical item ownership instead of skipping that line.
            let mut after_line = self.source.byte_to_line(tail.source.end.saturating_sub(1)) + 1;
            if let Some(owner) = &owner {
                let mut scan = after_line;
                while scan < self.source.len_lines() {
                    let at = self.source.line_to_byte(scan);
                    let Some(line) = self.projection.block_at_source(at) else {
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
                let Some(line) = self.projection.block_at_source(at) else {
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
                let neighbor = self.semantic_neighbor(at, forward, head.quote_depth)?;
                let line = neighbor.witness;
                if line.empty_comment || line.code || line.quote_depth != head.quote_depth {
                    return None;
                }
                if let Some(list) = &line.list {
                    if list.depth != depth {
                        return None;
                    }
                    if let Some(&marker) = resolved_owners
                        .get(&list.owner.start)
                        .filter(|_| neighbor.local)
                    {
                        return Some((marker, None));
                    }
                    if neighbor.local && planned_owners.contains(&list.owner.start) {
                        return None;
                    }
                    if list.ordinal.is_some() == ordered {
                        return Some((
                            neighbor.marker.unwrap(),
                            list.ordinal.map(|number| number + 1),
                        ));
                    }
                    return None;
                }
                resolved_lines
                    .get(&line.source.start)
                    .filter(|_| neighbor.local)
                    .copied()
                    .map(|marker| (marker, None))
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
            let marker = join.unwrap_or_else(|| {
                candidates
                    .iter()
                    .copied()
                    .find(|&marker| Some(marker) != before && Some(marker) != after)
                    .unwrap_or(candidates[0])
            });
            for index in first..last {
                result.markers[index] = marker;
                resolved_lines.insert(lines[index].source.start, marker);
            }
            if let Some(owner) = &owner {
                resolved_owners.insert(owner.start, marker);
            }
            let prefix = self
                .source
                .byte_slice(head.source.start..head.content.start)
                .to_string();
            let retained = if let Some(list) = &head.list {
                list.marker.start - head.source.start
            } else {
                prefix.rfind('>').map_or(0, |at| {
                    at + 1
                        + usize::from(matches!(prefix.as_bytes().get(at + 1), Some(b' ' | b'\t')))
                })
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

pub(super) fn nested_marker(current: &str, number: Option<u64>, index: usize) -> String {
    marker_at_number(current, number.map(|_| index as u64 + 1))
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
