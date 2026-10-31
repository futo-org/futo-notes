//! Canonical indentation roots and one physical prefix-emission pass.
use super::*;

impl EditorSession {
    pub(super) fn plan_list_indentation(
        &self,
        lines: &[crate::inline::blocks::BlockLine],
        item: &crate::inline::ListLine,
        add: bool,
    ) -> Result<(Vec<ContainerPlan>, usize), EditorError> {
        let mut plans = Vec::new();
        let mut materialized = 0;
        {
            let mut roots: Vec<_> = lines
                .iter()
                .filter_map(|line| {
                    crate::inline::visit_container();
                    line.list.as_ref()
                })
                .filter(|root| root.owner == item.owner)
                .cloned()
                .collect();
            roots.sort_by_key(|root| {
                crate::inline::visit_container();
                root.marker.start
            });
            roots.dedup_by_key(|root| {
                crate::inline::visit_container();
                root.marker.start
            });
            for (index, root) in roots.iter().enumerate() {
                crate::inline::visit_container();
                let head = self
                    .source
                    .line_to_byte(self.source.byte_to_line(root.marker.start));
                let (marker, column, shared_line) = if add {
                    let (range, number, column) = if let Some(sink) = &item.sink {
                        (sink.marker.clone(), sink.next_number, sink.column)
                    } else {
                        (
                            root.marker.clone(),
                            root.ordinal.map(|_| 1),
                            item.previous_content_column
                                .ok_or(EditorError::UnrepresentableFormat)?,
                        )
                    };
                    let marker = self.source.byte_slice(range).to_string();
                    materialized += marker.len();
                    (
                        super::list_styles::nested_marker(&marker, number, index),
                        column,
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
        Ok((plans, materialized))
    }

    pub(super) fn emit_list_indentation(
        &self,
        start: usize,
        raw: &str,
        quote_depth: usize,
        width: usize,
        plans: &[ContainerPlan],
    ) -> String {
        let mut output = String::with_capacity(raw.len() + width);
        let mut offset = 0;
        let mut active = 0;
        for line in raw.split_inclusive('\n') {
            crate::inline::visit_container();
            let line_at = start + offset;
            offset += line.len();
            while active + 1 < plans.len() && plans[active + 1].head <= line_at {
                active += 1;
            }
            let plan = plans.get(active);
            let prefix = super::indent_source::quote_prefix_end(line, quote_depth);
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
            if line.trim_matches([' ', '\t', '\r', '\n']).is_empty()
                && !self.projection.block_is_code(line_at)
            {
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
        output
    }
}
