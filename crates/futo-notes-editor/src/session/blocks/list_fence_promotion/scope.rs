//! Original canonical fenced-item scope, before any source is changed.
use super::*;
use crate::inline::blocks::ListCommandLine;
use crate::session::staging::PhysicalTail;

pub(super) type FenceRef<'a> = (
    &'a crate::inline::fences::Fence,
    usize,
    &'a crate::inline::blocks::BlockLine,
);

#[derive(Clone, Copy)]
pub(super) struct FenceTail {
    pub fence_end: usize,
    pub opener_line: usize,
    pub end: usize,
    pub needs_close: bool,
    pub quote_separator: bool,
    pub edge_quote_boundary: bool,
}

/// Borrowed opening-source facts, never child-document offset identities.
/// The owning source stays unchanged through planning and candidate proofs.
pub(super) struct FencedItem<'a> {
    pub first: &'a ListCommandLine,
    pub fences: Vec<FenceRef<'a>>,
    pub tail: FenceTail,
}
impl<'a> FencedItem<'a> {
    pub fn last(&self) -> FenceRef<'a> {
        *self.fences.last().unwrap()
    }
}

impl EditorSession {
    pub(super) fn fenced_item<'a>(
        &'a self,
        lines: &'a [ListCommandLine],
    ) -> Result<Option<FencedItem<'a>>, EditorError> {
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
        let mut fences: Vec<FenceRef<'_>> = Vec::new();
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
        let Some(&(fence, base, code)) = fences.last() else {
            return Ok(None);
        };
        let fence_end = if let Some(closer) = &fence.closer {
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
        if opener_line < first.source.end || fence_end > list.item.end {
            return Ok(None);
        }
        let end = list.item.end;
        let tail =
            self.resolve_fence_tail(first, (fence, base, code), fence_end, opener_line, end)?;
        Ok(Some(FencedItem {
            first,
            fences,
            tail,
        }))
    }

    fn resolve_fence_tail(
        &self,
        first: &ListCommandLine,
        last: FenceRef<'_>,
        fence_end: usize,
        opener_line: usize,
        end: usize,
    ) -> Result<FenceTail, EditorError> {
        let list = first.list.as_ref().unwrap();
        let (fence, base, code) = last;
        let (outside, boundary) =
            self.physical_fence_tail_at(base + fence.opener.start, fence_end, end);
        let Some(boundary) = boundary else {
            return Err(EditorError::UnrepresentableFormat);
        };
        if boundary.depth != list.depth
            || boundary.list_quote != list.quote_depth
            || boundary.code_quote != code.quote_depth
            || matches!(outside, PhysicalTail::Unknown)
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut quote_separator = false;
        let mut edge_quote_boundary = false;
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
                    quote_start,
                } if first_item == Some(true) && item_depth == Some(1) || empty_comment => {
                    if code.quote_depth == list.quote_depth && quote_depth == list.quote_depth {
                        true
                    } else if code.quote_depth > list.quote_depth && quote_depth < code.quote_depth
                    {
                        false
                    } else if list.quote_depth == 0
                        && code.quote_depth == 1
                        && quote_depth == 1
                        && first_item == Some(true)
                        && item_depth == Some(1)
                        && quote_start
                    {
                        if end < self.source.len_bytes() {
                            let (foreign, origin) = self
                                .projection
                                .block_ref_at_source(end)
                                .ok_or(EditorError::UnrepresentableFormat)?;
                            crate::inline::visit_container();
                            if !foreign.quote_start || origin + foreign.source.start != end {
                                return Err(EditorError::UnrepresentableFormat);
                            }
                        } else {
                            edge_quote_boundary = true;
                        }
                        quote_separator = fence_end == end;
                        false
                    } else {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                }
                _ => return Err(EditorError::UnrepresentableFormat),
            }
        };
        Ok(FenceTail {
            fence_end,
            opener_line,
            end,
            needs_close,
            quote_separator,
            edge_quote_boundary,
        })
    }
}
