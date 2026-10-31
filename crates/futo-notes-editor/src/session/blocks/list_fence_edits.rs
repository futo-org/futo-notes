//! One physical prefix sweep, source emission and original-source anchor index.
use super::list_fence_scope::{FenceTail, FencedItem};
use super::*;
use std::collections::BTreeMap;

pub(super) struct FenceEdits {
    pub footprint: std::ops::Range<usize>,
    pub output: String,
    pub edits: Vec<(std::ops::Range<usize>, String)>,
    deltas: Vec<(usize, isize)>,
    pub copied: usize,
    pub leading: &'static str,
    pub boundary_inserted: usize,
    pub eol: &'static str,
}
impl FenceEdits {
    pub fn mapped(&self, at: usize) -> Result<usize, EditorError> {
        let end = self.deltas.partition_point(|&(end, _)| {
            crate::inline::visit_container();
            end <= at
        });
        at.checked_add_signed(end.checked_sub(1).map_or(0, |i| self.deltas[i].1))
            .ok_or(EditorError::UnrepresentableFormat)
    }
    pub fn body_at(&self, at: usize, source_base: usize) -> Result<usize, EditorError> {
        self.mapped(at)?
            .checked_sub(if at == self.footprint.end {
                self.boundary_inserted
            } else {
                0
            })
            .and_then(|at| at.checked_sub(source_base))
            .ok_or(EditorError::UnrepresentableFormat)
    }
}

impl EditorSession {
    pub(super) fn spell_fenced_item(
        &self,
        item: &FencedItem<'_>,
    ) -> Result<Option<FenceEdits>, EditorError> {
        let first = item.first;
        let list = first.list.as_ref().unwrap();
        let (fence, _, _) = item.last();
        let FenceTail {
            fence_end,
            end,
            needs_close,
            quote_separator,
            ..
        } = item.tail;
        let start = first.source.start;
        let footprint = start..end;
        let raw = self.source.byte_slice(footprint.clone()).to_string();
        let prefix = self
            .source
            .byte_slice(start..first.content.start)
            .to_string();
        let retained = list.marker.start - start;
        let leading = self.fence_leading_separator(first)?;
        let mut head = prefix[..retained].to_owned();
        if !leading.is_empty() {
            head.push_str(leading);
            head.push_str(&prefix[..retained]);
        }
        let mut copied = raw.len() + prefix.len() + head.len();
        let mut edits = vec![(0..prefix.len(), head)];
        let Some((closing_prefix, swept)) = self.retired_fence_prefixes(item, &mut edits)? else {
            return Ok(None);
        };
        copied += swept;
        let eol = if fence_end >= 2 && self.source.byte(fence_end - 2) == b'\r' {
            "\r\n"
        } else {
            "\n"
        };
        if quote_separator {
            edits.push((end - start..end - start, eol.to_owned()));
            copied += eol.len();
        }
        if needs_close {
            let mut close = closing_prefix.ok_or(EditorError::UnrepresentableFormat)?;
            close.extend(std::iter::repeat_n(fence.marker as char, fence.width));
            close.push_str(eol);
            copied += fence.width + eol.len();
            edits.push((end - start..end - start, close));
        }
        let boundary_inserted = edits
            .last()
            .filter(|(range, _)| {
                crate::inline::visit_container();
                range.is_empty() && range.start == end - start
            })
            .map_or(0, |(_, text)| text.len());
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
        Ok(Some(FenceEdits {
            footprint,
            output,
            edits,
            deltas,
            copied,
            leading,
            boundary_inserted,
            eol,
        }))
    }

    fn retired_fence_prefixes(
        &self,
        item: &FencedItem<'_>,
        edits: &mut Vec<(std::ops::Range<usize>, String)>,
    ) -> Result<Option<(Option<String>, usize)>, EditorError> {
        let first = item.first;
        let list = first.list.as_ref().unwrap();
        let FenceTail {
            fence_end,
            opener_line,
            ..
        } = item.tail;
        let start = first.source.start;
        let mut copied = 0;
        let shifts = BTreeMap::from([(
            list.quote_depth,
            list.marker_column as isize - list.content_column as isize,
        )]);
        let mut at = first.source.end;
        let mut closing_prefix = None;
        while at < fence_end {
            crate::inline::visit_container();
            let physical = self
                .projection
                .source_prefix_at(at)
                .ok_or(EditorError::UnrepresentableFormat)?;
            if physical.source.end <= at || physical.source.end > fence_end {
                return Err(EditorError::UnrepresentableFormat);
            }
            if let Some(owner) = &physical.list {
                if owner.depth != list.depth
                    || owner.item != list.item
                    || owner.quote_depth != list.quote_depth
                {
                    return Ok(None);
                }
            } else if physical.code || !physical.content.is_empty() {
                return Ok(None);
            }
            // An actual prose blank or lazy continuation has no physical
            // retired container contribution. Preserve its authored bytes.
            if !physical.code && (physical.content.is_empty() || physical.prefix.is_empty()) {
                at = physical.source.end;
                continue;
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
        Ok(Some((closing_prefix, copied)))
    }
}
