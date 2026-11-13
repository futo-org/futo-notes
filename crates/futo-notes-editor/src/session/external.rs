//! Adopt outside contributions without recording them as local Undo actions
//! (`crate::engine::external` does the work).
use super::EditorSession;
use crate::{EditorError, Revision, SourceEdit, ViewChange};

/// A session- and revision-bound adoption prepared before the store commits merged bytes.
/// The fields are private: callers can only prepare and apply the same plan.
pub struct ExternalSourceAdoption {
    incarnation: u64,
    plan: crate::engine::Adoption,
}

impl ExternalSourceAdoption {
    /// The source edit the adoption makes; `None` when the merged text is the
    /// session's text already.
    pub(crate) fn edit(&self) -> Option<&SourceEdit> {
        self.plan.edit()
    }
}

impl EditorSession {
    /// Rebase every retained local history entry onto the outside contribution.
    /// Ambiguity declines adoption before either source or history changes.
    pub fn prepare_external_source(
        &self,
        expected: Revision,
        source: &str,
    ) -> Result<ExternalSourceAdoption, EditorError> {
        self.prepare(expected, source, true)
    }

    /// Adopt an outside source for a session with no unsaved local draft when
    /// its history cannot be rebased. The retained Undo/Redo stacks are
    /// dropped (the same result as reopening the note). Outside bytes may
    /// rewrite front matter, which local input never may.
    pub fn prepare_external_source_dropping_history(
        &self,
        expected: Revision,
        source: &str,
    ) -> Result<ExternalSourceAdoption, EditorError> {
        self.prepare(expected, source, false)
    }

    fn prepare(
        &self,
        expected: Revision,
        source: &str,
        keep_history: bool,
    ) -> Result<ExternalSourceAdoption, EditorError> {
        Ok(ExternalSourceAdoption {
            incarnation: self.incarnation,
            plan: self.engine.prepare_external(expected, source, keep_history)?,
        })
    }

    /// Apply a prepared adoption after the atomic store commit. No local edit
    /// can interleave while the attachment owner holds its session lock.
    pub fn apply_external_source(
        &mut self,
        adoption: ExternalSourceAdoption,
    ) -> Result<ViewChange, EditorError> {
        if adoption.incarnation != self.incarnation {
            return Err(EditorError::StaleClaim);
        }
        self.run(|e| e.adopt_view(adoption.plan, &mut |_| Ok(())))
    }
}
