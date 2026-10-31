//! Leading boundary proof for a root item promoted before fenced code.
use super::*;
use crate::inline::blocks::ListCommandLine;

impl EditorSession {
    /// Only an actual adjacent root-list paragraph can lazily absorb this
    /// promoted parent. Blank/opaque/empty predecessors keep their exact source.
    pub(super) fn fence_leading_separator(
        &self,
        first: &ListCommandLine,
    ) -> Result<&'static str, EditorError> {
        let list = first
            .list
            .as_ref()
            .ok_or(EditorError::UnrepresentableFormat)?;
        let Some(before) = self.semantic_neighbor(first.source.start, false, usize::MAX) else {
            return Ok("");
        };
        let witness = &before.witness;
        if witness.code
            || witness.empty_comment
            || witness.transparent_quote.is_some()
            || witness.list.is_none()
        {
            return Ok("");
        }
        // This slice cannot dereference an inherited outside source coordinate.
        // A valid unproved context remains required rather than unsafe acceptance.
        if !before.local {
            return Err(EditorError::UnrepresentableFormat);
        }
        if list.quote_depth != 0
            || witness.quote_depth != 0
            || !witness.list.as_ref().is_some_and(|l| l.depth == 1)
            || witness.source.end != first.source.start
        {
            return Ok("");
        }
        let (prior, base) = self
            .projection
            .block_ref_at_source(witness.source.start)
            .ok_or(EditorError::UnrepresentableFormat)?;
        crate::inline::visit_container();
        if !prior.paragraph_text || base + prior.source.end != first.source.start {
            return Ok("");
        }
        let ending = self.source.byte_slice(first.content.end..first.source.end);
        if ending
            .bytes()
            .inspect(|_| crate::inline::visit_container())
            .eq(b"\r\n".iter().copied())
        {
            Ok("\r\n")
        } else if ending
            .bytes()
            .inspect(|_| crate::inline::visit_container())
            .eq(b"\n".iter().copied())
        {
            Ok("\n")
        } else {
            Err(EditorError::UnrepresentableFormat)
        }
    }
}
