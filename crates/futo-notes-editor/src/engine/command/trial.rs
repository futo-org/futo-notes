//! Trying a command without making it: what a slot listing asks of a move.
use super::super::edit::Batch;
use super::super::Engine;
use super::Command;
use crate::EditWork;

impl Engine {
    /// Whether `run` would make `command`'s change: its edits pass the guard
    /// and change the text. The note is put back exactly as it was, with no
    /// acceptance or history; the trial's re-reads, both ways, are added to
    /// `work`.
    /// Callers hand it the very command `run` would get, so whatever that
    /// command writes is what is tried.
    pub(crate) fn would_run(&mut self, command: &Command, work: &mut EditWork) -> bool {
        // The guard reads every line the command names (a move names those
        // between the block and the slot), as `link_metadata_items`.
        work.link_metadata_items += command.lines.iter().map(|lines| lines.len()).sum::<usize>();
        let opening = self.point();
        let mut batch = Batch::default();
        let applied = matches!(self.apply(&mut batch, command), Ok(true));
        let changes = self.batch_text(&batch).is_some();
        let tried = batch.work;
        let reverted = self.revert(batch);
        for done in [tried, reverted] {
            work.parsed_source_bytes += done.parsed_source_bytes;
            work.materialized_source_bytes += done.materialized_source_bytes;
            work.inserted_bytes += done.inserted_bytes;
        }
        self.restore(&opening);
        applied && changes
    }
}
