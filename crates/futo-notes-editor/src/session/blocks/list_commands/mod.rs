//! List commands touch their selected bodies and retain unrelated source bytes.
use super::*;
mod marker;

#[derive(Clone, Copy, PartialEq, Eq)]
enum LiftScope {
    AllAncestors,
    CurrentContainer,
}

impl EditorSession {
    pub(super) fn list_command(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        command: BlockCommand,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.scoped_list_command(expected, range, command, LiftScope::AllAncestors, accept)
    }

    /// Key exits and one-level Outdent retain list ancestors above a quote.
    pub(super) fn lift_current_list(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<Option<ViewChange>, EditorError> {
        self.scoped_list_command(
            expected,
            range,
            BlockCommand::Heading(0),
            LiftScope::CurrentContainer,
            accept,
        )
    }
}

#[cfg(test)]
#[path = "work.rs"]
mod work_tests;

mod apply;
mod body;
pub(super) use body::protect_list_body;

#[cfg(test)]
#[path = "task_forest_work.rs"]
mod task_forest_work_tests;
