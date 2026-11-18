//! Trying a command without making it: what a slot listing asks of a move.
use super::super::edit::Batch;
use super::super::Engine;
use super::Command;
use crate::EditWork;

impl Engine {
    /// Whether `run` would make `command`'s change: its edits pass the guard
    /// and change the text. The note is put back exactly as it was, with no
    /// acceptance or history; the trial's re-reads are added to `work`.
    /// Callers hand it the very command `run` would get, so whatever that
    /// command writes is what is tried.
    pub(crate) fn would_run(&mut self, command: &Command, work: &mut EditWork) -> bool {
        let opening = self.point();
        let mut batch = Batch::default();
        let applied = matches!(self.apply(&mut batch, command), Ok(true));
        let changes = self.changes_then_revert(batch, work);
        self.restore(&opening);
        applied && changes
    }
}
