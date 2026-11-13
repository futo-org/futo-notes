//! Debounced save schedule: 500 ms after the last edit, at most 2 s after the
//! first unsaved one (the shipping editor's `BODY_SAVE_DEBOUNCE_MS` /
//! `BODY_SAVE_MAX_WAIT_MS`).
use std::time::Duration;

use futo_notes_editor::{EditorError, EditorSession, Revision, SourceEdit};

use super::{Attachment, EditorStoreError, SaveStatus};

pub(super) const IDLE: Duration = Duration::from_millis(500);
pub(super) const MAX_WAIT: Duration = Duration::from_secs(2);

/// Hosts that apply the engine's accept hook without storage use this.
pub(super) fn no_accept(_: &SourceEdit) -> Result<(), String> {
    Ok(())
}

pub(super) struct SaveSchedule {
    /// The revision last written to markdown (or opened).
    pub saved: Revision,
    max_deadline: Option<Duration>,
    idle_deadline: Option<Duration>,
}

impl SaveSchedule {
    pub(super) fn clean(saved: Revision) -> Self {
        Self {
            saved,
            max_deadline: None,
            idle_deadline: None,
        }
    }

    fn due(&self) -> Option<Duration> {
        match (self.max_deadline, self.idle_deadline) {
            (Some(max), Some(idle)) => Some(max.min(idle)),
            (max, idle) => max.or(idle),
        }
    }
}

impl Attachment {
    /// An edit landed: the first unsaved one starts the max-wait window, every
    /// one restarts the idle window.
    pub(super) fn note_edit(&mut self) {
        let now = self.clock.now();
        self.save.max_deadline.get_or_insert(now + MAX_WAIT);
        self.save.idle_deadline = Some(now + IDLE);
    }

    /// The markdown now matches the draft.
    pub(super) fn mark_saved(&mut self) {
        self.save = SaveSchedule::clean(self.engine.revision());
    }

    /// The file changed under this draft before anything was saved: the next
    /// save is due now.
    pub(super) fn save_now(&mut self) {
        let now = self.clock.now();
        self.save.max_deadline = Some(now);
        self.save.idle_deadline = Some(now);
    }

    /// A failed save is retried in 2 s so a host loop does not spin.
    pub(super) fn schedule_retry(&mut self) {
        let retry = self.clock.now() + MAX_WAIT;
        self.save.max_deadline = Some(retry);
        self.save.idle_deadline = Some(retry);
    }

    pub fn save_delay(&self) -> Option<Duration> {
        self.save
            .due()
            .map(|due| due.saturating_sub(self.clock.now()))
    }

    pub(super) fn save_due(&self) -> bool {
        self.save.due().is_some_and(|due| due <= self.clock.now())
    }

    pub fn save_status(&self) -> SaveStatus {
        SaveStatus {
            revision: self.engine.revision(),
            saved: self.save.saved,
            save_deadline: self.save.due(),
        }
    }

    /// Run one engine input in memory, then schedule a save if it changed the
    /// draft. The engine's accept hook stays, but nothing is persisted from it.
    pub(super) fn edit<T>(
        &mut self,
        operation: impl FnOnce(
            &mut EditorSession,
            &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        ) -> Result<T, EditorError>,
    ) -> Result<T, EditorStoreError> {
        self.input_ready()?;
        let before = self.engine.revision();
        let result = operation(&mut self.engine, &mut no_accept).map_err(EditorStoreError::Editor);
        if self.engine.revision() != before {
            self.note_edit();
        }
        result
    }
}
