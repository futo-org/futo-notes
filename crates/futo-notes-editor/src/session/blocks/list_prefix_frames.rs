//! Explicit physical frames for empty list parents sharing a quoted body.
use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum FrameAction {
    Outdent,
    Backspace,
}

impl EditorSession {
    pub(super) fn shared_prefix_frames(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        action: FrameAction,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let lines = self.selected_list_lines(range);
        let [line] = lines.as_slice() else {
            return Ok(None);
        };
        let Some(list) = line.list.as_ref() else {
            return Ok(None);
        };
        // This slice owns a complete single physical body. Multi-line quoted
        // paragraphs use their existing path until their whole scope is planned.
        if line.code
            || line.heading != 0
            || list.checked.is_some()
            || !list.first
            || line.quote_depth == 0
            || list.item.end > line.source.end
            || line.quote_depth <= list.quote_depth
            || list.depth > 2
            || (action == FrameAction::Backspace
                && (range.start != range.end
                    || range.start.0 != self.projection.display_at(line.content.start)))
        {
            return Ok(None);
        }
        let (items, planning, _) = self
            .projection
            .list_items_at(&self.source, list.marker.start);
        let prefix = self
            .source
            .byte_slice(line.source.start..line.content.start)
            .to_string();
        let mut headers = Vec::new();
        for item in &items {
            crate::inline::visit_container();
            if line.source.start <= item.marker.start
                && item.marker.start <= list.marker.start
                && item.item.start <= list.marker.start
                && list.marker.start < item.item.end
            {
                let start = item.marker.start - line.source.start;
                let end = item.indent;
                if start >= end || end > prefix.len() || item.checked.is_some() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                headers.push((start, end, item.content_column - item.marker_column));
            }
        }
        let quote_end = super::indent_source::canonical_quote_end(&prefix, line.quote_depth)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let quote_start = if action == FrameAction::Backspace {
            // Registered joinBackward merges through all quote barriers
            // after this header into its preceding empty paragraph.
            list.indent
        } else {
            let previous = super::indent_source::canonical_quote_end(&prefix, line.quote_depth - 1)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let mut at = previous;
            while prefix.as_bytes().get(at) != Some(&b'>') {
                crate::inline::visit_container();
                if at >= quote_end {
                    return Err(EditorError::UnrepresentableFormat);
                }
                at += 1;
            }
            crate::inline::visit_container();
            at
        };
        let ending = self
            .source
            .byte_slice(line.content.end..line.source.end)
            .to_string();
        let newline = if ending.ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let parallel = action == FrameAction::Outdent && line.quote_depth == list.quote_depth + 1;
        let mut output = String::new();
        let mut copied = planning + prefix.len() + ending.len();
        output.push_str(&prefix[..quote_start]);
        copied += quote_start;
        if parallel {
            // Only the paragraph newly lifted beside the list's empty first
            // paragraph needs a physical frame. Existing implicit ancestors
            // keep their exact compact header spelling.
            output.push_str(newline);
            copied += newline.len();
            let mut at = 0;
            for &(start, end, columns) in &headers {
                crate::inline::visit_container();
                output.push_str(&prefix[at..start]);
                output.extend(std::iter::repeat_n(' ', columns));
                copied += start - at + columns;
                at = end;
            }
            output.push_str(&prefix[at..quote_start]);
            copied += quote_start - at;
        }
        output.push_str(&prefix[quote_end..]);
        copied += prefix.len() - quote_end;
        let footprint = line.source.start..line.content.start;
        let edits = [(0..prefix.len(), output.clone())];
        copied += output.len();
        let (selection, parsed, materialized) =
            self.preview_header_selection(range, footprint.clone(), &edits, &output)?;
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            footprint,
            &output,
            BlockSelection::Display(selection),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        change.work.parsed_source_bytes += planning + parsed;
        change.work.materialized_source_bytes += copied + materialized;
        Ok(Some(change))
    }
}

#[cfg(test)]
#[path = "list_prefix_frames_work.rs"]
mod work_tests;
