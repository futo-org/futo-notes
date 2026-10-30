//! Lift selected list text while promoting its remaining container tail.
use super::*;
use crate::inline::blocks::BlockLine;

impl EditorSession {
    pub(super) fn lift_nested_list(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        lines: &[BlockLine],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let first = &lines[0];
        let selected = first
            .list
            .as_ref()
            .ok_or(EditorError::UnrepresentableFormat)?;
        let start = first.source.start;
        let end = selected.outer_item.end;
        let after = self
            .semantic_neighbor(end, true, selected.quote_depth)
            .filter(|neighbor| {
                neighbor
                    .witness
                    .list
                    .as_ref()
                    .is_some_and(|list| list.depth == selected.outer_depth)
            });
        let quote = self
            .source
            .byte_slice(start..first.content.start)
            .to_string();
        let retained = super::indent_source::quote_prefix_end(&quote, selected.quote_depth);
        let base = crate::inline::columns(&quote[..retained], 0);
        let shared_line = selected
            .parent_marker
            .as_ref()
            .is_some_and(|parent| parent.start >= start);
        let ending = self
            .source
            .byte_slice(first.content.end..first.source.end)
            .to_string();
        let newline = if ending.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let separator = selected.parent_marker.is_some() || {
            let line = self.source.byte_to_line(start);
            if line == 0 {
                false
            } else {
                let previous = self.source.line_to_byte(line - 1);
                let nonempty = !self.source.byte_slice(previous..start).chars().all(|ch| {
                    crate::inline::visit_container();
                    matches!(ch, ' ' | '\t' | '\r' | '\n')
                });
                nonempty
                    && self
                        .projection
                        .source_prefix_at(previous)
                        .and_then(|prefix| prefix.list)
                        .is_some_and(|list| {
                            list.owner == selected.owner
                                && !lines.iter().any(|line| {
                                    line.list
                                        .as_ref()
                                        .is_some_and(|other| other.marker == list.marker)
                                })
                        })
            }
        };
        let mut output = String::new();
        if shared_line {
            output.push_str(&quote[..selected.marker.start - start]);
            output.push_str(newline);
        }
        if separator {
            output.push_str(quote[..retained].trim_end());
            output.push_str(newline);
        }
        output.push_str(&quote[..retained]);
        let mut materialized = quote.len() + ending.len();
        let body = self.source.byte_slice(first.content.clone()).to_string();
        let (body, mut parsed) = super::content::protect_content(&body, false, true);
        output.push_str(&body);
        output.push_str(&ending);
        materialized += body.len();
        let mut at = first.source.end;
        let mut shift = selected.content_column - base;
        while at < end {
            crate::inline::visit_container();
            let prefix = self
                .projection
                .source_prefix_at(at)
                .ok_or(EditorError::UnrepresentableFormat)?;
            if prefix.source.end <= at {
                return Err(EditorError::UnrepresentableFormat);
            }
            if let Ok(index) = lines.binary_search_by_key(&at, |line| line.source.start) {
                let line = &lines[index];
                if let Some(list) = line.list.as_ref() {
                    shift = list.content_column - base;
                    let raw = self.source.byte_slice(line.content.clone()).to_string();
                    let (body, work) = super::content::protect_content(&raw, false, true);
                    parsed += work;
                    output.push_str(&quote[..retained]);
                    output.push_str(&body);
                    let ending = self
                        .source
                        .byte_slice(line.content.end..line.source.end)
                        .to_string();
                    output.push_str(&ending);
                    materialized += raw.len() + body.len() + ending.len();
                    at = line.source.end;
                    continue;
                }
            }
            if let Some(list) = &prefix.list {
                if list.first
                    && list.marker.start >= selected.item.end
                    && list.depth <= selected.depth
                {
                    shift = list.marker_column - base;
                }
            }
            let raw = self.source.byte_slice(prefix.prefix.clone()).to_string();
            let blank = !prefix.code
                && self
                    .source
                    .byte_slice(prefix.content.clone())
                    .chars()
                    .all(|ch| {
                        crate::inline::visit_container();
                        matches!(ch, ' ' | '\t' | '\r' | '\n')
                    });
            let mut moved = super::indent_source::shift_prefix(
                &raw,
                selected.quote_depth,
                -(shift as isize),
                blank,
            );
            if let Some(list) = prefix
                .list
                .as_ref()
                .filter(|list| list.first && list.marker_column == base + shift)
            {
                let after_marker = after
                    .as_ref()
                    .filter(|neighbor| {
                        neighbor.witness.list.as_ref().is_some_and(|foreign| {
                            foreign.ordinal.is_some() == list.ordinal.is_some()
                        })
                    })
                    .and_then(|neighbor| neighbor.marker);
                let marker = super::list_styles::independent_marker(
                    list.ordinal.is_some(),
                    None,
                    after_marker,
                );
                let cut = super::indent_source::quote_prefix_end(&moved, selected.quote_depth);
                let width = list.marker.len();
                moved.replace_range(cut + width - 1..cut + width, &(marker as char).to_string());
            }
            output.push_str(&moved);
            let tail = self
                .source
                .byte_slice(prefix.prefix.end..prefix.source.end.min(end))
                .to_string();
            output.push_str(&tail);
            materialized += raw.len() + moved.len() + tail.len();
            at = prefix.source.end;
        }
        let mut selection = range;
        let added = newline.len() * (usize::from(separator) + usize::from(shared_line));
        selection.start.0 += added;
        selection.end.0 += added;
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
        change.work.parsed_source_bytes += parsed;
        change.work.materialized_source_bytes += materialized;
        Ok(Some(change))
    }
}
