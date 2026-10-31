//! Final canonical meaning proofs for promoted item source.
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
