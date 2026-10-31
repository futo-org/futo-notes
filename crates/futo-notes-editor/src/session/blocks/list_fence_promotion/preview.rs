//! Final canonical meaning proofs for promoted item source.
use super::edits::FenceEdits;
use super::scope::FencedItem;
use super::*;

use crate::inline::blocks::ListCommandLine;

impl EditorSession {
    pub(super) fn verify_promoted_fence_outside(
        &self,
        preview: &Self,
        original: usize,
        shifted: usize,
    ) -> Result<(), EditorError> {
        let old = self
            .projection
            .list_command_line_at_source(original)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let new = preview
            .projection
            .list_command_line_at_source(shifted)
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
        let (old_block, old_base) = self
            .projection
            .block_ref_at_source(original)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let (new_block, new_base) = preview
            .projection
            .block_ref_at_source(shifted)
            .ok_or(EditorError::UnrepresentableFormat)?;
        if meaning(&old) != meaning(&new)
            || old_block.quote_start != new_block.quote_start
            || old_base + old_block.source.start != original
            || new_base + new_block.source.start != shifted
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(())
    }

    pub(super) fn verify_promoted_prose(
        &self,
        preview: &Self,
        footprint: &std::ops::Range<usize>,
        mapped: impl Fn(usize) -> Result<usize, EditorError>,
    ) -> Result<(), EditorError> {
        let mut result = Ok(());
        self.projection
            .visit_source_blocks(footprint, |block, base| {
                if result.is_err() || block.code || !block.paragraph_text {
                    return;
                }
                crate::inline::visit_container();
                result = (|| {
                    let at = mapped(base + block.content.start)?;
                    let actual = preview
                        .projection
                        .list_command_line_at_source(at)
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    if actual.code
                        || actual.divider
                        || actual.list.is_some()
                        || actual.heading != block.heading
                        || actual.quote_depth != block.quote_depth
                    {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    Ok(())
                })();
            });
        result
    }
}

pub(super) struct FencePreview {
    session: EditorSession,
    window: std::ops::Range<usize>,
    display: usize,
    old_display_len: usize,
    pub work: EditWork,
}
pub(super) struct FenceDisplayDelta {
    head_at: usize,
    separator_at: usize,
    tail_added: usize,
}

impl EditorSession {
    pub(super) fn preview_fenced_item(
        &self,
        plan: &FenceEdits,
    ) -> Result<FencePreview, EditorError> {
        let (start, end) = (plan.footprint.start, plan.footprint.end);
        let bounds = start..if end < self.source.len_bytes() {
            end + 1
        } else {
            end
        };
        let (window, display) = self.projection.retained_point_window(bounds);
        let preview_raw = self.source.byte_slice(window.clone()).to_string();
        let mut preview = self.stage_source(&preview_raw, window.clone())?;
        #[cfg(test)]
        crate::inline::coordinate_work_tests::child(
            "fence-initial",
            EditWork {
                link_metadata_items: preview.projection.initial_link_metadata_items,
                link_copied_bytes: preview.projection.initial_link_copied_bytes,
                ..Default::default()
            },
        );
        let prepared = preview.prepare_source(
            preview.revision(),
            SourceRange {
                start: SourceOffset(start - window.start),
                end: SourceOffset(end - window.start),
            },
            &plan.output,
        )?;
        let original_display_len = preview.projection.display.len_bytes();
        let initial_items = preview.projection.initial_link_metadata_items;
        let initial_copied = preview.projection.initial_link_copied_bytes;
        let mut work = preview.apply(&prepared).work;
        #[cfg(test)]
        crate::inline::coordinate_work_tests::child("fence-apply", work);
        work.parsed_source_bytes += 2 * preview_raw.len();
        work.materialized_source_bytes += preview_raw.len() + plan.output.len();
        work.link_metadata_items += initial_items;
        work.link_copied_bytes += initial_copied;
        Ok(FencePreview {
            session: preview,
            window,
            display,
            old_display_len: original_display_len,
            work,
        })
    }
}

impl FencePreview {
    pub fn verify_display(
        &self,
        original: &EditorSession,
        item: &FencedItem<'_>,
        plan: &FenceEdits,
    ) -> Result<FenceDisplayDelta, EditorError> {
        let preview = &self.session;
        let first = item.first;
        let (fence, base, _) = item.last();
        let end = item.tail.end;
        let edge_quote_boundary = item.tail.edge_quote_boundary;
        let quote_separator = item.tail.quote_separator;
        let eol = plan.eol;
        let leading = plan.leading;
        let (display, original_display_len) = (self.display, self.old_display_len);
        let exposed = original
            .source
            .byte_slice(if edge_quote_boundary && quote_separator {
                base + fence.separator.start..base + fence.separator.end
            } else {
                0..0
            });
        if edge_quote_boundary
            && quote_separator
            && (exposed.len_bytes() != eol.len()
                || !exposed.bytes().zip(eol.bytes()).all(|(a, b)| {
                    crate::inline::visit_container();
                    a == b
                }))
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        let tail_added = exposed.len_bytes() + if quote_separator { eol.len() } else { 0 };
        let added = leading.len() + tail_added;
        if original_display_len + added != preview.projection.display.len_bytes() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let before = original
            .projection
            .display
            .byte_slice(display..display + original_display_len);
        let separator_at = original
            .projection
            .display_at(end)
            .checked_sub(display)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let head_at = original
            .projection
            .display_at(first.content.start)
            .checked_sub(display)
            .ok_or(EditorError::UnrepresentableFormat)?;
        if head_at > separator_at || separator_at > before.len_bytes() {
            return Err(EditorError::UnrepresentableFormat);
        }
        let inserted = if quote_separator { eol.as_bytes() } else { b"" };
        if !before
            .byte_slice(..head_at)
            .bytes()
            .chain(leading.bytes())
            .chain(before.byte_slice(head_at..separator_at).bytes())
            .chain(exposed.bytes())
            .chain(inserted.iter().copied())
            .chain(before.byte_slice(separator_at..).bytes())
            .zip(preview.projection.display.bytes())
            .all(|(a, b)| {
                crate::inline::visit_container();
                a == b
            })
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(FenceDisplayDelta {
            head_at,
            separator_at,
            tail_added,
        })
    }

    pub fn verify_parent(
        &self,
        item: &FencedItem<'_>,
        plan: &FenceEdits,
    ) -> Result<(), EditorError> {
        let preview = &self.session;
        let window = &self.window;
        let first = item.first;
        let list = first.list.as_ref().unwrap();
        let parent_at = plan
            .mapped(first.content.start)?
            .checked_sub(window.start)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let parent = preview
            .projection
            .list_command_line_at_source(parent_at)
            .ok_or(EditorError::UnrepresentableFormat)?;
        crate::inline::visit_container();
        if parent.content.start != parent_at
            || parent.content.end <= parent_at
            || parent.source.end <= parent_at
            || parent.code
            || parent.divider
            || parent.heading != 0
            || parent.list.is_some()
            || parent.quote_depth != list.quote_depth
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(())
    }

    pub fn verify_fences(
        &self,
        item: &FencedItem<'_>,
        plan: &FenceEdits,
    ) -> Result<(), EditorError> {
        let preview = &self.session;
        let window = &self.window;
        let (fence, base, _) = item.last();
        let needs_close = item.tail.needs_close;
        let last_opener = base + fence.opener.start;
        for &(fence, base, code) in &item.fences {
            let (actual, actual_base) = preview
                .projection
                .block_ref_at_source(plan.mapped(base + fence.opener.start)? - window.start)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let actual_fence = actual
                .fence
                .as_ref()
                .ok_or(EditorError::UnrepresentableFormat)?;
            crate::inline::visit_container();
            if !actual.code
                || actual.quote_start != code.quote_start
                || actual.quote_depth != code.quote_depth
                || actual.list.is_some()
                || actual.code_language != code.code_language
                || actual_fence.marker != fence.marker
                || actual_fence.width != fence.width
                || actual_base + actual_fence.body.start
                    != plan.body_at(base + fence.body.start, window.start)?
                || actual_base + actual_fence.body.end
                    != plan.body_at(base + fence.body.end, window.start)?
                || actual_base + actual_fence.opener.start
                    != plan.mapped(base + fence.opener.start)? - window.start
                || needs_close
                    && base + fence.opener.start == last_opener
                    && actual_fence.closer.is_none()
            {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(())
    }

    pub fn verify_quote_end(
        &self,
        item: &FencedItem<'_>,
        plan: &FenceEdits,
    ) -> Result<(), EditorError> {
        let preview = &self.session;
        let window = &self.window;
        let (fence, base, _) = item.last();
        let last_opener = base + fence.opener.start;
        let edge_quote_boundary = item.tail.edge_quote_boundary;
        if edge_quote_boundary {
            let (actual, actual_base) = preview
                .projection
                .block_ref_at_source(plan.mapped(last_opener)? - window.start)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let actual_fence = actual
                .fence
                .as_ref()
                .ok_or(EditorError::UnrepresentableFormat)?;
            let physical_end = preview.source.len_bytes();
            let physical = preview
                .source
                .line_to_byte(preview.source.byte_to_line(physical_end - 1));
            let closed = preview
                .projection
                .source_prefix_at(physical)
                .ok_or(EditorError::UnrepresentableFormat)?;
            crate::inline::visit_container();
            if closed.code
                || closed.quote_depth != 0
                || closed.list.is_some()
                || closed.source.end != physical_end
                || !closed.content.is_empty()
                || preview.source.byte(physical_end - 1) != b'\n'
                || actual_fence.closer.is_some()
                || actual_base + actual_fence.whole.end > physical
            {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(())
    }

    pub fn verify_surrounding(
        &self,
        original: &EditorSession,
        plan: &FenceEdits,
    ) -> Result<(), EditorError> {
        original.verify_promoted_prose(&self.session, &plan.footprint, |at| {
            plan.mapped(at)?
                .checked_sub(self.window.start)
                .ok_or(EditorError::UnrepresentableFormat)
        })?;
        if plan.footprint.end < original.source.len_bytes() {
            original.verify_promoted_fence_outside(
                &self.session,
                plan.footprint.end,
                plan.mapped(plan.footprint.end)? - self.window.start,
            )?;
        }
        Ok(())
    }

    pub fn project_selection(
        &self,
        original: &EditorSession,
        plan: &FenceEdits,
        range: DisplayRange,
        delta: FenceDisplayDelta,
    ) -> Result<DisplayRange, EditorError> {
        let preview = &self.session;
        let window = &self.window;
        let display = self.display;
        // Original complete atoms must survive every fine-grained prefix edit.
        let mut selection = range;
        for endpoint in [&mut selection.start.0, &mut selection.end.0] {
            let at = *endpoint;
            let point = original.projection.retained_point(at)?;
            let shifted = point
                .through_edits(plan.footprint.start, &plan.edits)?
                .relative(window.start)?;
            point.verify_raw(&original.source, shifted, &preview.source)?;
            let mapped_display = display + preview.projection.project_retained_point(shifted)?;
            let expected_display =
                at + if at >= display + delta.head_at {
                    plan.leading.len()
                } else {
                    0
                } + if at >= display + delta.separator_at {
                    delta.tail_added
                } else {
                    0
                };
            if mapped_display != expected_display {
                return Err(EditorError::UnrepresentableFormat);
            }
            *endpoint = mapped_display;
        }
        Ok(selection)
    }
}
