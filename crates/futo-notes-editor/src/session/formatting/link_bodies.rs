//! A link command whose selection leaves its table cell: one link per body it
//! covers, as the inline format toggles do, never across a pipe or a row.
use super::*;

impl EditorSession {
    /// Set `destination` on each body of `range` (a paragraph, a table cell),
    /// in one acceptance and one Undo group. A body that cannot take it is
    /// skipped; none taking it changes nothing.
    pub(in crate::session) fn set_link_bodies(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        destination: &str,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        let Bodies { bodies, .. } = self.format_bodies(range);
        let (window, display_start) = self.projection.edit_window(range);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut staged = self.stage_source(&raw, window.clone())?;
        let mut transaction = Transaction::new(&staged.source);
        let mut work = EditWork {
            materialized_source_bytes: raw.len(),
            parsed_source_bytes: staged.projection.initial_parse_work,
            link_metadata_items: staged.projection.initial_link_metadata_items + 2 * bodies.len(),
            link_copied_bytes: staged.projection.initial_link_copied_bytes,
            ..EditWork::default()
        };
        let mut applied = false;
        for body in &bodies {
            // A link never changes display text, so every body keeps its
            // opening display range in the staged window.
            let local = DisplayRange {
                start: DisplayOffset(body.range.start.0 - display_start),
                end: DisplayOffset(body.range.end.0 - display_start),
            };
            let result = staged.set_link_in_scope(
                staged.revision(),
                local,
                None,
                destination,
                body.cell,
                &mut |edit| {
                    transaction.apply(edit.range, &edit.inserted);
                    Ok(())
                },
            );
            match result {
                Ok(Some(change)) => {
                    accumulate_planning_work(&mut work, change.work);
                    applied = true;
                }
                Ok(None)
                | Err(EditorError::UnrepresentableFormat | EditorError::Persistence(_)) => {}
                Err(error) => return Err(error),
            }
        }
        if !applied {
            return Ok(None);
        }
        let (mut source_range, inserted) = transaction.finish();
        source_range.start.0 += window.start;
        source_range.end.0 += window.start;
        let edit = self.prepare_source(expected, source_range, &inserted)?;
        let pending = staged.prepare_pending_for_parent(window.start);
        let guard_validation = self.validate_stage_guards(&edit, window, &pending)?;
        self.commit_bodies(edit, Some(pending), guard_validation, work, accept)
            .map(Some)
    }
}
