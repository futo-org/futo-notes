//! Inline format toggles through the ordinary accepted history path.

use super::*;

impl EditorSession {
    /// A collapsed toggle changes the carried format without writing empty
    /// markdown. A selected toggle is one accepted, byte-exact history action.
    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: InlineFormat,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.check_revision(expected)?;
        let committed = self.commit_composition(expected, None, accept)?;
        if self
            .projection
            .block_lines(self.selection)
            .iter()
            .all(|line| line.code)
        {
            return Ok(committed);
        }
        if self.selection.start == self.selection.end {
            let mut formats = self.active_formats();
            if formats.contains(&format) {
                formats.retain(|value| *value != format);
            } else {
                formats.push(format);
                formats.sort();
            }
            self.pending_formats = Some(formats);
            self.typing = None;
            return Ok(committed);
        }
        let before_selection = self.selection;
        let (before_source, before_source_work) = self.capture_history_selection();
        let before_affinity = self.affinity;
        let before_formats = self.pending_formats.clone();
        let mut plan = self.projection.edit(
            &self.source,
            self.selection,
            "",
            self.affinity,
            None,
            crate::inline::EditIntent::Toggle(format),
        )?;
        let edit = self.prepare_source(
            expected,
            SourceRange {
                start: SourceOffset(plan.range.start),
                end: SourceOffset(plan.range.end),
            },
            &plan.inserted,
        )?;
        let before_links = self.projection.pending_for_source_edit(edit.range);
        let prepared = self.prepare_plan_pending(&edit, &plan, &before_links, None)?;
        accept(&edit).map_err(EditorError::Persistence)?;
        let mut change = self.apply(&edit);
        self.install_plan_pending(&mut plan, prepared, &mut change, true);
        self.selection = before_selection;
        self.pending_formats = None;
        change.selection = self.selection;
        change.work.materialized_source_bytes += plan.materialized;
        change.work.parsed_source_bytes += plan.parsed;
        change.work.link_metadata_items += plan.link_metadata_items;
        change.work.link_copied_bytes += plan.link_copied_bytes;
        let (after_source, after_source_work) = self.capture_history_selection();
        change.work.link_metadata_items += before_source_work + after_source_work;
        let after_links = self
            .projection
            .pending_links(before_links.after_window(&edit));
        change.work.link_metadata_items += before_links.work + after_links.work;
        self.undo.push(HistoryGroup {
            entries: vec![HistoryEntry {
                before_source,
                after_source,
                before_selection,
                before_affinity,
                before_formats,
                before_links,
                after_selection: self.selection,
                after_affinity: self.affinity,
                after_formats: None,
                after_links,
                range: edit.range,
                removed: edit.removed,
                inserted: edit.inserted,
            }],
        });
        self.typing = None;
        self.redo.clear();
        Ok(Some(change))
    }
}
