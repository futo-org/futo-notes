use super::*;

impl BoundedEditorSession {
    /// Explicitly proportional handoff. Replay the actual accepted edits into
    /// the retained canonical projection in the same engine, preserving its
    /// transient witnesses. No callback, new source acceptance or history step.
    pub fn materialize(mut self) -> (EditorSession, BoundedWork) {
        let selection = self.engine.selection;
        let affinity = self.engine.affinity;
        let formats = self.engine.pending_formats.take();
        let mut work = BoundedWork::default();
        for record in self.source_records.iter().rev() {
            work.metadata_items += 1;
            let edit = &record.edit;
            let start = self.engine.source.byte_to_char(edit.range.start.0);
            let end = self
                .engine
                .source
                .byte_to_char(edit.range.start.0 + edit.inserted.len());
            self.engine.source.remove(start..end);
            self.engine.source.insert(start, &edit.removed);
            self.engine.revision = edit.previous_revision;
            work.inspected_source_bytes += edit.inserted.len() + edit.removed.len();
        }
        if !self.source_records.is_empty() {
            // Compose only at this explicit proportional handoff. One canonical
            // apply preserves transient fields without reparsing the giant row
            // once for every earlier key.
            let mut transaction = crate::history::Transaction::new(&self.engine.source);
            let final_revision = self.source_records.back().unwrap().edit.revision;
            for record in &self.source_records {
                work.metadata_items += 1;
                let edit = &record.edit;
                transaction.apply(edit.range, &edit.inserted);
                work.input_bytes += edit.inserted.len();
            }
            let (range, inserted) = transaction.finish();
            let mut edit = self
                .engine
                .prepare_source(self.engine.revision, range, &inserted)
                .expect("accepted code records compose into their original source");
            edit.revision = final_revision;
            work.copied_bytes += edit.removed.len() + inserted.len() + edit.inserted.len();
            let change = self.engine.apply(&edit);
            work.inspected_source_bytes += change.work.materialized_source_bytes;
            work.parsed_source_bytes += change.work.parsed_source_bytes;
            work.copied_bytes += change.work.materialized_source_bytes
                + change.work.link_copied_bytes
                + change.inserted.len()
                + change.projection.text.len();
            work.metadata_items += change.work.link_metadata_items
                + change.projection.correspondence.len()
                + change.projection.blocks.len()
                + change.projection.runs.len()
                + change.projection.links.len();
        }
        if self
            .progress
            .as_ref()
            .is_some_and(|progress| progress.changed)
        {
            let refreshed = self
                .engine
                .projection
                .refresh_bounded_suffix(&self.engine.source, self.code.whole.start);
            work.inspected_source_bytes += refreshed.inspected_source_bytes;
            work.parsed_source_bytes += refreshed.parsed_source_bytes;
            work.copied_bytes += refreshed.copied_bytes;
            work.metadata_items += refreshed.metadata_items;
        }
        for accepted in self.deferred {
            if accepted.joins_previous {
                self.engine
                    .undo
                    .last_mut()
                    .unwrap()
                    .entries
                    .push(accepted.history);
            } else {
                self.engine.undo.push(HistoryGroup {
                    entries: vec![accepted.history],
                });
            }
            work.metadata_items += 1;
        }
        for group in self.redo_groups {
            work.metadata_items += 1;
            self.engine.redo.push(HistoryGroup {
                entries: group
                    .into_iter()
                    .map(|accepted| {
                        work.metadata_items += 1;
                        accepted.history
                    })
                    .collect(),
            });
        }
        for group in &self.retired_groups {
            work.retired_history_records += group.len();
            for accepted in group {
                work.retired_history_payload_bytes +=
                    accepted.history.removed.len() + accepted.history.inserted.len();
            }
        }
        for group in &self.retired_redo {
            work.retired_history_records += 1 + group.entries.len();
            for entry in &group.entries {
                work.retired_history_payload_bytes += entry.removed.len() + entry.inserted.len();
            }
        }
        let (resulting, visits) = self
            .engine
            .project_history_selection(self.history_selection, selection);
        work.metadata_items += visits;
        self.engine.selection = resulting;
        if let Some(run) = &mut self.engine.typing {
            run.rebase_selection(selection, resulting);
        }
        self.engine.affinity = affinity;
        self.engine.pending_formats = formats;
        self.engine.bounded_work = work;
        (self.engine, work)
    }
}
