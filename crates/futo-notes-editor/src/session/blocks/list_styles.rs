//! Pick a supported marker without changing either neighboring list. When the
//! two ordered delimiters are both occupied, one standard empty comment keeps
//! the chosen list independent (CommonMark 0.31.2, example 308).
use super::*;
use crate::inline::blocks::BlockLine;
use std::collections::{HashMap, HashSet};

pub(super) struct ListStyles {
    pub markers: Vec<u8>,
    pub comments: Vec<(usize, String)>,
}

enum ListIntent {
    Independent,
    Shortcut { start: Option<u64> },
}

impl EditorSession {
    pub(super) fn list_styles(&self, lines: &[BlockLine], command: BlockCommand) -> ListStyles {
        self.plan_list_styles(lines, command, ListIntent::Independent)
    }

    pub(super) fn list_shortcut_styles(&self, line: &BlockLine, start: Option<u64>) -> ListStyles {
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
    ) -> ListStyles {
        let ordered = command == BlockCommand::OrderedList;
        let candidates: &[u8] = if ordered { b".)" } else { b"-+*" };
        let planned_owners: HashSet<_> = lines
            .iter()
            .filter_map(|line| line.list.as_ref().map(|list| list.owner.start))
            .collect();
        let planned_lines: HashSet<_> = lines.iter().map(|line| line.source.start).collect();
        let mut resolved_owners = HashMap::new();
        let mut resolved_lines = HashMap::new();
        let mut result = ListStyles {
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
            let neighbor = |mut index: isize, direction: isize| {
                while index >= 0 && (index as usize) < self.source.len_lines() {
                    let at = self.source.line_to_byte(index as usize);
                    let Some(line) = self.projection.block_at_source(at) else {
                        return None;
                    };
                    if line.empty_comment || line.code || line.quote_depth != head.quote_depth {
                        return None;
                    }
                    let blank = self
                        .source
                        .byte_slice(line.content.clone())
                        .chars()
                        .all(|ch| matches!(ch, ' ' | '\t'));
                    if blank && line.list.as_ref().is_none_or(|list| !list.first) {
                        index += direction;
                        continue;
                    }
                    if let Some(list) = &line.list {
                        if list.depth != depth {
                            return None;
                        }
                        if let Some(&marker) = resolved_owners.get(&list.owner.start) {
                            return Some((marker, None));
                        }
                        if planned_owners.contains(&list.owner.start) {
                            return None;
                        }
                        if list.ordinal.is_some() == ordered {
                            return Some((
                                self.source
                                    .byte_slice(list.marker.end - 1..list.marker.end)
                                    .bytes()
                                    .next()
                                    .unwrap(),
                                list.ordinal.map(|number| number + 1),
                            ));
                        }
                        return None;
                    }
                    if let Some(&marker) = resolved_lines.get(&line.source.start) {
                        return Some((marker, None));
                    }
                    if planned_lines.contains(&line.source.start) || !line.content.is_empty() {
                        return None;
                    }
                    index += direction;
                }
                None
            };
            let preceding = neighbor(before_line as isize - 1, -1);
            let before = preceding.map(|(marker, _)| marker);
            let after = neighbor(after_line as isize, 1).map(|(marker, _)| marker);
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
