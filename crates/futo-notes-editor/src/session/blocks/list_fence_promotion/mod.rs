//! Promote a complete canonical fenced item through one preview and commit.
use super::*;
use crate::inline::blocks::ListCommandLine;

mod boundary;
mod edits;
mod preview;
mod scope;

#[cfg(test)]
mod leading_tests;
#[cfg(test)]
mod origin_tests;

impl EditorSession {
    pub(super) fn promote_root_list_fence(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        lines: &[ListCommandLine],
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Some(item) = self.fenced_item(lines)? else {
            return Ok(None);
        };
        let Some(plan) = self.spell_fenced_item(&item)? else {
            return Ok(None);
        };
        let preview = self.preview_fenced_item(&plan)?;
        let delta = preview.verify_display(self, &item, &plan)?;
        preview.verify_parent(&item, &plan)?;
        preview.verify_fences(&item, &plan)?;
        preview.verify_quote_end(&item, &plan)?;
        preview.verify_surrounding(self, &plan)?;
        let selection = preview.project_selection(self, &plan, range, delta)?;
        let work = preview.work;
        let formats = (range == self.selection)
            .then(|| self.pending_formats.clone())
            .flatten();
        let affinity = self.input_affinity(range);
        let mut change = self.commit_block_edit(
            expected,
            plan.footprint,
            &plan.output,
            BlockSelection::Display(selection),
            None,
            accept,
        )?;
        self.carry_block_state(&mut change, formats, affinity);
        accumulate_planning_work(&mut change.work, work);
        change.work.materialized_source_bytes += plan.copied;
        Ok(Some(change))
    }
}

#[cfg(test)]
mod work_tests;
