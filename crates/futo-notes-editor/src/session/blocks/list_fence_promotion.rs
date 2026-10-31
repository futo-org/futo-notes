//! Retire one root item whose final code fence relied on its list boundary.
use super::*;
use crate::inline::blocks::ListCommandLine;
use crate::session::staging::PhysicalTail;
use std::collections::BTreeMap;

impl EditorSession {
    pub(super) fn promote_root_list_fence(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        lines: &[ListCommandLine],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let [first] = lines else { return Ok(None) };
        let Some(list) = first.list.as_ref() else {
            return Ok(None);
        };
        if !list.first
            || list.depth != 1
            || first.code
            || first.heading != 0
            || first.task.is_some()
            || first.quote_depth != list.quote_depth
        {
            return Ok(None);
        }
        let mut fences: Vec<(
            &crate::inline::fences::Fence,
            usize,
            &crate::inline::blocks::BlockLine,
        )> = Vec::new();
        self.projection
            .visit_source_blocks(&list.item, |block, base| {
                if let Some(fence) = &block.fence {
                    if fences.last().is_none_or(|(prior, origin, _)| {
                        origin + prior.opener.start != base + fence.opener.start
                    }) {
                        fences.push((fence, base, block));
                    }
                }
            });
        let [(fence, base, code)] = fences.as_slice() else {
            return Ok(None);
        };
        let (fence, base, code) = (*fence, *base, *code);
        let end = if let Some(closer) = &fence.closer {
            // A closed event ends at its delimiter; prefix retirement owns the
            // actual closer row including its unchanged physical ending.
            let physical = self
                .source
                .line_to_byte(self.source.byte_to_line(base + closer.start));
            let row = self
                .projection
                .source_prefix_at(physical)
                .ok_or(EditorError::UnrepresentableFormat)?;
            if !row.code {
                return Err(EditorError::UnrepresentableFormat);
            }
            row.source.end
        } else {
            base + fence.whole.end
        };
        let opener_line = self
            .source
            .line_to_byte(self.source.byte_to_line(base + fence.opener.start));
        if opener_line != first.source.end || end != list.item.end {
            return Ok(None);
        }
        let outside = if end < self.source.len_bytes() {
            let prefix = self
                .projection
                .source_prefix_at(end)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let block = self
                .projection
                .list_command_line_at_source(end)
                .ok_or(EditorError::UnrepresentableFormat)?;
            PhysicalTail::Row {
                code: prefix.code,
                quote_depth: prefix.quote_depth,
                first_item: prefix.list.as_ref().map(|l| l.first),
                item_depth: prefix.list.as_ref().map(|l| l.depth),
                empty_comment: block.empty_comment,
                fence_item_end: self.projection.fence_item_end_at(end),
            }
        } else {
            self.physical_tail()
        };
        let needs_close = if fence.closer.is_some() {
            false
        } else {
            match outside {
                PhysicalTail::Eof => false,
                PhysicalTail::Row {
                    code: false,
                    quote_depth,
                    first_item,
                    item_depth,
                    empty_comment,
                    fence_item_end: Some((1, list_quote, fence_quote)),
                } if list_quote == list.quote_depth
                    && fence_quote == code.quote_depth
                    && (first_item == Some(true) && item_depth == Some(1) || empty_comment) =>
                {
                    if code.quote_depth == list.quote_depth && quote_depth == list.quote_depth {
                        true
                    } else if code.quote_depth > list.quote_depth && quote_depth < code.quote_depth
                    {
                        false
                    } else {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                }
                _ => return Err(EditorError::UnrepresentableFormat),
            }
        };
        let start = first.source.start;
        let footprint = start..end;
        let raw = self.source.byte_slice(footprint.clone()).to_string();
        let prefix = self
            .source
            .byte_slice(start..first.content.start)
            .to_string();
        let retained = list.marker.start - start;
        let mut edits = vec![(0..prefix.len(), prefix[..retained].to_owned())];
        let mut copied = raw.len() + prefix.len() + retained;
        let shifts = BTreeMap::from([(
            list.quote_depth,
            list.marker_column as isize - list.content_column as isize,
        )]);
        let mut at = first.source.end;
        let mut closing_prefix = None;
        while at < end {
            crate::inline::visit_container();
            let physical = self
                .projection
                .source_prefix_at(at)
                .ok_or(EditorError::UnrepresentableFormat)?;
            if physical.source.end <= at || physical.source.end > end || !physical.code {
                return Err(EditorError::UnrepresentableFormat);
            }
            let old = self.source.byte_slice(physical.prefix.clone()).to_string();
            let moved =
                super::indent_source::shift_prefixes(&old, physical.quote_depth, &shifts, false)?;
            copied += old.len() + moved.len();
            if at == opener_line {
                closing_prefix = Some(moved.clone());
                copied += moved.len();
            }
            edits.push((
                physical.prefix.start - start..physical.prefix.end - start,
                moved,
            ));
            at = physical.source.end;
        }
        if needs_close {
            let eol = if end >= 2 && self.source.byte(end - 2) == b'\r' {
                "\r\n"
            } else {
                "\n"
            };
            let mut close = closing_prefix.ok_or(EditorError::UnrepresentableFormat)?;
            close.extend(std::iter::repeat_n(fence.marker as char, fence.width));
            close.push_str(eol);
            copied += fence.width + eol.len();
            edits.push((end - start..end - start, close));
        }
        let output = super::transaction::spell_edits(&raw, &edits)?;
        copied += output.len();
        // One delta index maps every original canonical source anchor. Prefix
        // count never multiplies the number of validation queries.
        let mut deltas = Vec::with_capacity(edits.len());
        let mut delta = 0isize;
        for (edit, text) in &edits {
            crate::inline::visit_container();
            delta += text.len() as isize - edit.len() as isize;
            deltas.push((start + edit.end, delta));
        }
        let mapped = |at: usize| -> Result<usize, EditorError> {
            let end = deltas.partition_point(|&(end, _)| {
                crate::inline::visit_container();
                end <= at
            });
            at.checked_add_signed(end.checked_sub(1).map_or(0, |i| deltas[i].1))
                .ok_or(EditorError::UnrepresentableFormat)
        };
        let bounds = start..if end < self.source.len_bytes() {
            end + 1
        } else {
            end
        };
        let (window, display) = self.projection.retained_point_window(bounds);
        let preview_raw = self.source.byte_slice(window.clone()).to_string();
        let mut preview = self.stage_source(&preview_raw, window.clone());
        let prepared = preview.prepare_source(
            preview.revision(),
            SourceRange {
                start: SourceOffset(start - window.start),
                end: SourceOffset(end - window.start),
            },
            &output,
        )?;
        let original_display_len = preview.projection.display.len_bytes();
        let work = preview.apply(&prepared).work;
        if original_display_len != preview.projection.display.len_bytes() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let before = self
            .projection
            .display
            .byte_slice(display..display + preview.projection.display.len_bytes());
        if !before
            .bytes()
            .zip(preview.projection.display.bytes())
            .all(|(a, b)| {
                crate::inline::visit_container();
                a == b
            })
            || before.len_bytes() != preview.projection.display.len_bytes()
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        let (actual, actual_base) = preview
            .projection
            .block_ref_at_source(mapped(base + fence.opener.start)? - window.start)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let actual_fence = actual
            .fence
            .as_ref()
            .ok_or(EditorError::UnrepresentableFormat)?;
        crate::inline::visit_container();
        if !actual.code
            || actual.quote_depth != code.quote_depth
            || actual.list.is_some()
            || actual.code_language != code.code_language
            || actual_fence.marker != fence.marker
            || actual_fence.width != fence.width
            || actual_base + actual_fence.opener.start
                != mapped(base + fence.opener.start)? - window.start
            || needs_close && actual_fence.closer.is_none()
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        if end < self.source.len_bytes() {
            let old = self
                .projection
                .list_command_line_at_source(end)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let new = preview
                .projection
                .list_command_line_at_source(mapped(end)? - window.start)
                .ok_or(EditorError::UnrepresentableFormat)?;
            crate::inline::visit_container();
            let meaning = |line: &ListCommandLine| {
                (
                    line.code,
                    line.quote_depth,
                    line.list
                        .as_ref()
                        .map(|l| (l.depth, l.ordinal, l.checked, l.first)),
                    line.empty_comment,
                )
            };
            if meaning(&old) != meaning(&new) {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        // Original complete atoms must survive every fine-grained prefix edit.
        for at in [range.start.0, range.end.0] {
            let point = self.projection.retained_point(at)?;
            let shifted = point.through_edits(start, &edits)?.relative(window.start)?;
            point.verify_raw(&self.source, shifted, &preview.source)?;
            if display + preview.projection.project_retained_point(shifted)? != at {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        let parsed = 2 * preview_raw.len() + work.parsed_source_bytes;
        copied += preview_raw.len() + output.len() + work.materialized_source_bytes;
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            footprint,
            &output,
            BlockSelection::Display(range),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        change.work.parsed_source_bytes += parsed;
        change.work.materialized_source_bytes += copied;
        Ok(Some(change))
    }
}

#[cfg(test)]
#[path = "list_fence_promotion_work.rs"]
mod work_tests;
