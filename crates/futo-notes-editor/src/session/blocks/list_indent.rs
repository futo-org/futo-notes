//! Container indentation uses canonical item ownership and content columns.
use super::*;

struct ContainerPlan {
    head: usize,
    marker_at: usize,
    prefix_end: usize,
    column: usize,
    marker: String,
    padding: String,
    body_delta: isize,
    shared_line: bool,
    display_anchor: usize,
}

impl EditorSession {
    pub(super) fn indent_list(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.projection.block_lines(range);
        let Some(first) = lines.first().filter(|line| !line.code) else {
            return Ok(None);
        };
        let Some(item) = &first.list else {
            return Ok(None);
        };
        if first.quote_depth > item.quote_depth {
            return Ok(None);
        }
        let (width, add) = if command == BlockCommand::Indent {
            let Some(column) = item.previous_content_column else {
                return Ok(None);
            };
            let Some(width) = column
                .checked_sub(item.marker_column)
                .filter(|width| *width > 0)
            else {
                return Ok(None);
            };
            (width, true)
        } else {
            let Some(column) = item.parent_marker_column else {
                return self.list_command(expected, range, BlockCommand::Heading(0), accept);
            };
            (item.marker_column - column, false)
        };
        let start = self
            .source
            .line_to_byte(self.source.byte_to_line(item.marker.start));
        let end = lines
            .iter()
            .filter_map(|line| line.list.as_ref())
            .filter(|other| other.owner == item.owner)
            .map(|other| other.item.end)
            .max()
            .unwrap_or(item.item.end);
        let raw = self.source.byte_slice(start..end).to_string();
        let mut plans = Vec::new();
        let mut materialized = raw.len();
        {
            let mut roots: Vec<_> = lines
                .iter()
                .filter_map(|line| line.list.as_ref())
                .filter(|root| root.owner == item.owner)
                .cloned()
                .collect();
            roots.sort_by_key(|root| root.marker.start);
            roots.dedup_by_key(|root| root.marker.start);
            for (index, root) in roots.iter().enumerate() {
                let head = self
                    .source
                    .line_to_byte(self.source.byte_to_line(root.marker.start));
                let (marker, column, shared_line) = if add {
                    let marker = self.source.byte_slice(root.marker.clone()).to_string();
                    materialized += marker.len();
                    (
                        super::list_styles::nested_marker(&marker, root.ordinal, index),
                        item.previous_content_column
                            .ok_or(EditorError::UnrepresentableFormat)?,
                        false,
                    )
                } else {
                    let parent_range = root
                        .parent_marker
                        .clone()
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    let parent = self.source.byte_slice(parent_range.clone()).to_string();
                    materialized += parent.len();
                    (
                        super::list_styles::lifted_marker(
                            &parent,
                            root.parent_number.map(|number| number + index as u64),
                        ),
                        root.parent_marker_column
                            .ok_or(EditorError::UnrepresentableFormat)?,
                        parent_range.start >= head,
                    )
                };
                let padding = self
                    .source
                    .byte_slice(root.marker.end..head + root.indent)
                    .to_string();
                let body_delta = crate::inline::columns(&padding, column + marker.len()) as isize
                    - root.content_column as isize;
                materialized += padding.len();
                plans.push(ContainerPlan {
                    head,
                    marker_at: root.marker.start - head,
                    prefix_end: root.indent,
                    column,
                    marker,
                    padding,
                    body_delta,
                    shared_line,
                    display_anchor: self.projection.display_at(root.marker.start),
                });
            }
        }
        let mut output = String::with_capacity(raw.len() + width);
        let mut offset = 0;
        let mut active = 0;
        for line in raw.split_inclusive('\n') {
            let line_at = start + offset;
            offset += line.len();
            while active + 1 < plans.len() && plans[active + 1].head <= line_at {
                active += 1;
            }
            let plan = plans.get(active);
            let prefix = quote_prefix_end(line, item.quote_depth);
            let base = crate::inline::columns(&line[..prefix], 0);
            output.push_str(&line[..prefix]);
            if let Some(plan) = plan.filter(|plan| plan.head == line_at) {
                if plan.shared_line {
                    output.push_str(&line[prefix..plan.marker_at]);
                    output.push('\n');
                    output.push_str(&line[..prefix]);
                }
                output.push_str(&" ".repeat(plan.column - base));
                output.push_str(&plan.marker);
                output.push_str(&plan.padding);
                output.push_str(&line[plan.prefix_end..]);
                continue;
            }
            let line = &line[prefix..];
            if line.trim_matches([' ', '\t', '\r', '\n']).is_empty() {
                output.push_str(line);
                continue;
            }
            let body_delta = plan.map_or(width as isize, |plan| plan.body_delta);
            if body_delta >= 0 {
                output.push_str(&" ".repeat(body_delta as usize));
                output.push_str(line);
            } else {
                let width = body_delta.unsigned_abs();
                let mut column = base;
                let mut bytes = 0;
                for byte in line.bytes() {
                    if column - base >= width || !matches!(byte, b' ' | b'\t') {
                        break;
                    }
                    column = crate::inline::columns(&line[bytes..bytes + 1], column);
                    bytes += 1;
                }
                output.push_str(&" ".repeat((column - base).saturating_sub(width)));
                output.push_str(&line[bytes..]);
            }
        }
        let mut selection = range;
        for endpoint in [&mut selection.start.0, &mut selection.end.0] {
            let opening = *endpoint;
            *endpoint += plans
                .iter()
                .filter(|plan| plan.shared_line && plan.display_anchor <= opening)
                .count();
        }
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
        change.work.materialized_source_bytes += materialized;
        Ok(Some(change))
    }
}

/// Only enclosing quote prefixes precede a list's indentation. Quote markers
/// inside the item are shifted with its body, never mistaken for its parent.
pub(super) fn quote_prefix_end(line: &str, depth: usize) -> usize {
    let mut at = 0;
    for _ in 0..depth {
        let spaces = line[at..].bytes().take_while(|&b| b == b' ').count().min(3);
        if line.as_bytes().get(at + spaces) != Some(&b'>') {
            break;
        }
        at += spaces + 1;
        if matches!(line.as_bytes().get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
    }
    at
}
