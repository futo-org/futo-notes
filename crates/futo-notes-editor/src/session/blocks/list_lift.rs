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
        let mut outer = selected.clone();
        while let Some(parent) = &outer.parent_marker {
            crate::inline::visit_container();
            let next = self
                .projection
                .source_prefix_at(parent.start)
                .and_then(|prefix| prefix.list)
                .filter(|list| list.depth < outer.depth)
                .ok_or(EditorError::UnrepresentableFormat)?;
            outer = next;
        }
        let start = first.source.start;
        let end = outer.item.end;
        let after = self
            .semantic_neighbor(end, true, selected.quote_depth)
            .filter(|neighbor| {
                neighbor
                    .witness
                    .list
                    .as_ref()
                    .is_some_and(|list| list.depth == outer.depth)
            });
        let quote = self
            .source
            .byte_slice(start..first.content.start)
            .to_string();
        let retained = super::indent_source::quote_prefix_end(&quote, selected.quote_depth);
        let base = crate::inline::columns(&quote[..retained], 0);
        let mut output = format!("{}\n{}", quote[..retained].trim_end(), &quote[..retained]);
        let mut materialized = quote.len();
        let body = self.source.byte_slice(first.content.clone()).to_string();
        let (body, parsed) = super::content::protect_content(&body, false, true);
        output.push_str(&body);
        output.push_str(
            &self
                .source
                .byte_slice(first.content.end..first.source.end)
                .to_string(),
        );
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
                    .all(|ch| matches!(ch, ' ' | '\t' | '\r' | '\n'));
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
        selection.start.0 += 1;
        selection.end.0 += 1;
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
