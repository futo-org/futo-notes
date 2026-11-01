use super::*;
use crate::{
    BoundedChange, BoundedCursor, BoundedEditorSession, BoundedError, BoundedProgress,
    BoundedSourceOperation, BoundedWork, DisplayOffset, ProjectionContinuation,
};
mod contract;
pub use contract::*;
mod acknowledgement;
mod materialize;

/// Page-owned presentation and history. The transport incarnation is issued by
/// the Store worker; it never replaces the page core's local cursor incarnation.
pub struct PortableBoundedSession {
    engine: BoundedEditorSession,
    mode: BoundedModeReady,
    sequence: u64,
    waiting: Option<BoundedHostRequest>,
    pending: Option<(SourceEdit, BoundedSourceOperation, BoundedFrame)>,
    displayed: Revision,
    accepted: Revision,
    durable: Revision,
    paused: bool,
    reset_required: bool,
    relink: Option<RelinkOffer>,
}

impl PortableSession {
    pub fn begin_bounded_entry(
        &mut self,
        body_caret: DisplayOffset,
    ) -> Result<BoundedModeRequest, PortableError> {
        self.ready()?;
        if self.accepted != self.engine.revision() {
            return Err(PortableError::Busy);
        }
        if self.engine.composition().is_some() {
            return Err(PortableError::Editor(EditorError::CompositionActive));
        }
        self.sequence += 1;
        let request = BoundedModeRequest {
            token: self.token,
            sequence: self.sequence,
            revision: self.accepted,
            body_caret,
        };
        self.bounded_entry = Some(request.clone());
        Ok(request)
    }
    /// A refused host entry retains its old receipt authority; canceling this
    /// page handshake restores the same Full owner without source/history work.
    pub fn cancel_bounded_entry(&mut self) {
        self.bounded_entry = None;
    }

    pub fn complete_bounded_entry(
        self,
        mode: BoundedModeReady,
    ) -> Result<PortableBoundedSession, PortableBoundedEntryError> {
        if self.bounded_entry.as_ref() != Some(&mode.request)
            || mode.incarnation == 0
            || mode.durable.0 > self.accepted.0
            || mode.durable.0 < self.durable.0
            || self.waiting.is_some()
            || self.pending.is_some()
            || self.paused
        {
            return Err(PortableBoundedEntryError {
                session: Box::new(self),
                error: PortableError::InvalidAcknowledgement,
            });
        }
        let Self {
            engine,
            token,
            sequence,
            waiting,
            pending,
            displayed,
            accepted,
            durable,
            paused,
            relink,
            bounded_entry,
        } = self;
        match engine.into_bounded(accepted, token, mode.request.body_caret) {
            Ok(mut engine) => {
                engine.require_source_witness();
                Ok(PortableBoundedSession {
                    engine,
                    mode: mode.clone(),
                    sequence,
                    waiting: None,
                    pending: None,
                    displayed,
                    accepted,
                    durable: mode.durable,
                    paused: false,
                    reset_required: false,
                    relink,
                })
            }
            Err(error) => Err(PortableBoundedEntryError {
                session: Box::new(PortableSession {
                    engine: *error.session,
                    token,
                    sequence,
                    waiting,
                    pending,
                    displayed,
                    accepted,
                    durable,
                    paused,
                    relink,
                    bounded_entry,
                }),
                error: PortableError::Bounded(error.error),
            }),
        }
    }
}

impl PortableBoundedSession {
    fn ready(&self) -> Result<(), PortableError> {
        if self.reset_required {
            return Err(PortableError::ModeResetRequired);
        }
        if self.paused {
            return Err(PortableError::Paused);
        }
        if self.waiting.is_some() || self.pending.is_some() {
            return Err(PortableError::Busy);
        }
        if self.sequence == u64::MAX {
            return Err(PortableError::SequenceExhausted);
        }
        Ok(())
    }
    pub fn cursor(&self) -> Result<BoundedCursor, PortableError> {
        self.ready()?;
        Ok(self.engine.cursor())
    }
    pub fn draft_text(&self) -> String {
        self.engine.source_text()
    }
    pub fn status(&self) -> PortableStatus {
        PortableStatus {
            local: self.engine.source_authority().revision,
            displayed: self.displayed,
            accepted: self.accepted,
            durable: self.durable,
            paused: self.paused,
            waiting: self.waiting.is_some(),
        }
    }
    pub fn reset_required(&self) -> bool {
        self.reset_required
    }
    pub fn preparation_work(&self) -> BoundedWork {
        self.engine.preparation_work()
    }

    fn request(
        &mut self,
        operation: BoundedHostOperation,
    ) -> Result<BoundedHostRequest, PortableError> {
        if self.waiting.is_some() {
            return Err(PortableError::Busy);
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or(PortableError::SequenceExhausted)?;
        let request = BoundedHostRequest {
            token: self.mode.request.token,
            incarnation: self.mode.incarnation,
            sequence: self.sequence,
            operation,
        };
        self.waiting = Some(request.clone());
        Ok(request)
    }
    fn stage(
        &mut self,
        edit: SourceEdit,
        frame: BoundedFrame,
    ) -> Result<BoundedHostRequest, PortableError> {
        let operation = self
            .engine
            .last_source_operation()
            .ok_or(PortableError::Bounded(BoundedError::Unsupported))?;
        let request = self.request(BoundedHostOperation::Append {
            edit: edit.clone(),
            operation: operation.clone(),
        })?;
        self.pending = Some((edit, operation, frame));
        Ok(request)
    }
    pub fn insert_literal(
        &mut self,
        cursor: BoundedCursor,
        at: DisplayOffset,
        inserted: &str,
    ) -> Result<BoundedHostRequest, PortableError> {
        self.ready()?;
        let mut edit = None;
        let frame = self
            .engine
            .insert_literal(cursor, at, inserted, &mut |record| {
                edit = Some(record.clone());
                Ok(())
            })?;
        self.stage(edit.unwrap(), BoundedFrame::Literal(frame))
    }
    /// Foreign input is bounded before Rust decoding; binding argument lifting
    /// and caller-owned UTF-16 allocation remain outside these Rust counters.
    /// `at` remains an authoritative UTF-8 display-byte offset; this method
    /// converts inserted text only, never scans the display for coordinates.
    pub fn insert_literal_utf16(
        &mut self,
        cursor: BoundedCursor,
        at: DisplayOffset,
        inserted: &[u16],
    ) -> Result<BoundedHostRequest, PortableError> {
        self.ready()?;
        if inserted.len() > 2 {
            return Err(PortableError::Bounded(BoundedError::Unsupported));
        }
        let lifted_bytes = std::mem::size_of_val(inserted);
        let inserted = String::from_utf16(inserted)
            .map_err(|_| PortableError::Editor(EditorError::InvalidText))?;
        let request = self.insert_literal(cursor, at, &inserted)?;
        let Some((_, _, BoundedFrame::Literal(frame))) = &mut self.pending else {
            unreachable!("literal input staged a literal frame")
        };
        frame.work.input_bytes += lifted_bytes;
        frame.work.copied_bytes += inserted.len();
        Ok(request)
    }
    pub fn insert_prefix_literal(
        &mut self,
        cursor: BoundedCursor,
        at: DisplayOffset,
        inserted: &str,
    ) -> Result<BoundedHostRequest, PortableError> {
        self.ready()?;
        let mut edit = None;
        let frame = self
            .engine
            .insert_prefix_literal(cursor, at, inserted, &mut |record| {
                edit = Some(record.clone());
                Ok(())
            })?;
        self.stage(
            edit.unwrap(),
            BoundedFrame::Progress(BoundedProgress::Change(frame)),
        )
    }
    pub fn remove_fence_closer(
        &mut self,
        cursor: BoundedCursor,
    ) -> Result<BoundedHostRequest, PortableError> {
        self.ready()?;
        let mut edit = None;
        let frame = self.engine.remove_fence_closer(cursor, &mut |record| {
            edit = Some(record.clone());
            Ok(())
        })?;
        self.stage(
            edit.unwrap(),
            BoundedFrame::Progress(BoundedProgress::Change(frame)),
        )
    }
    pub fn select_bounded(
        &mut self,
        cursor: BoundedCursor,
        range: DisplayRange,
        affinity: crate::Affinity,
    ) -> Result<BoundedProgress, PortableError> {
        self.ready()?;
        Ok(self.engine.select_bounded(cursor, range, affinity)?)
    }
    pub fn continue_projection(
        &mut self,
        continuation: ProjectionContinuation,
    ) -> Result<BoundedProgress, PortableError> {
        self.ready()?;
        Ok(self.engine.continue_projection(continuation)?)
    }
    pub fn undo_bounded(
        &mut self,
        cursor: BoundedCursor,
    ) -> Result<Option<BoundedHostRequest>, PortableError> {
        self.history(cursor, false)
    }
    pub fn redo_bounded(
        &mut self,
        cursor: BoundedCursor,
    ) -> Result<Option<BoundedHostRequest>, PortableError> {
        self.history(cursor, true)
    }
    fn history(
        &mut self,
        cursor: BoundedCursor,
        redo: bool,
    ) -> Result<Option<BoundedHostRequest>, PortableError> {
        self.ready()?;
        let mut edit = None;
        let mut capture = |record: &SourceEdit| {
            edit = Some(record.clone());
            Ok(())
        };
        let frame = if redo {
            self.engine.redo_bounded(cursor, &mut capture)?
        } else {
            self.engine.undo_bounded(cursor, &mut capture)?
        };
        frame
            .map(|frame| self.stage(edit.unwrap(), BoundedFrame::Progress(frame)))
            .transpose()
    }
    pub fn flush(&mut self) -> Result<BoundedHostRequest, PortableError> {
        self.ready()?;
        self.request(BoundedHostOperation::Flush)
    }
    pub fn resume(&mut self) -> Result<BoundedHostRequest, PortableError> {
        self.waiting = None;
        self.paused = true;
        self.request(BoundedHostOperation::Resume)
    }
    pub fn retry_pending(&mut self) -> Result<BoundedHostRequest, PortableError> {
        if self.paused {
            return Err(PortableError::Paused);
        }
        let (edit, operation, _) = self.pending.as_ref().ok_or(PortableError::Busy)?;
        self.request(BoundedHostOperation::Append {
            edit: edit.clone(),
            operation: operation.clone(),
        })
    }
}
