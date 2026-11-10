//! Selected closed frames retire through ordinary replacement before block
//! placement. Both stages remain one externally accepted source/history action.
use super::*;

impl EditorSession {
    pub(super) fn paste_retiring_fence(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        newline: &str,
        selection_work: usize,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let mut change =
            self.stage_block_action(expected, range, None, accept, |staged, local, accept| {
                let removed = staged.replace_action(
                    staged.revision(),
                    local,
                    "",
                    crate::InputAction::Isolated,
                    accept,
                )?;
                let Some(mut pasted) = staged.paste_input(
                    staged.revision(),
                    staged.selection(),
                    PasteInput::Normalized { text, newline },
                    accept,
                )?
                else {
                    return Ok(Some(removed));
                };
                pasted.work.materialized_source_bytes += removed.work.materialized_source_bytes;
                pasted.work.parsed_source_bytes += removed.work.parsed_source_bytes;
                pasted.work.link_metadata_items += removed.work.link_metadata_items;
                pasted.work.link_copied_bytes += removed.work.link_copied_bytes;
                Ok(Some(pasted))
            })?;
        if let Some(change) = &mut change {
            change.work.link_metadata_items += selection_work;
        }
        Ok(change)
    }

    /// The code block's paste (`fence_paste`). Text pasted over a selection
    /// from code out of it lands as code text, planned with the frame the
    /// selection crosses (`inline::Repair`) inside a checked paste.
    pub(super) fn code_paste(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        text: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        if crate::inline::Repair::may() && self.projection.leaves_code(range) {
            let _repair = crate::inline::Repair::hold();
            match self.replace_markdown_action(expected, range, text, accept) {
                Err(EditorError::UnrepresentableFormat) => {}
                change => return change.map(Some),
            }
        }
        self.fence_paste(expected, range, text, accept)
    }
}
