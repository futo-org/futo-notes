//! Asynchronous page/worker contract. No callback here performs storage I/O.
mod bounded;
pub use bounded::*;
mod clipboard;
mod composition;
mod links;
use serde::{Deserialize, Serialize};

use crate::{
    DisplayRange, DisplayUtf16Range, EditorError, EditorSession, Revision, SourceEdit, ViewChange,
};

/// Host-issued incarnation, unique across note switches and page reloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionToken(pub u64);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostOperation {
    Append(SourceEdit),
    Flush,
    Resume,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRequest {
    pub token: SessionToken,
    pub sequence: u64,
    pub operation: HostOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostAck {
    pub token: SessionToken,
    pub sequence: u64,
    pub accepted: Revision,
    pub durable: Revision,
    pub paused: bool,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relink: Option<RelinkOffer>,
}

/// A successful own-action relink may be adopted only while the page still
/// holds its exact acknowledged source revision. Adoption uses normal append
/// acceptance before releasing its view change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelinkOffer {
    pub revision: Revision,
    pub action: crate::OwnActionRelink,
}

impl HostRequest {
    pub fn accepted(&self, accepted: Revision, durable: Revision) -> HostAck {
        HostAck {
            token: self.token,
            sequence: self.sequence,
            accepted,
            durable,
            paused: false,
            error: None,
            relink: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableStatus {
    pub local: Revision,
    pub displayed: Revision,
    pub accepted: Revision,
    pub durable: Revision,
    pub paused: bool,
    pub waiting: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortableError {
    Editor(EditorError),
    Bounded(crate::BoundedError),
    ModeResetRequired,
    Busy,
    Paused,
    InvalidAcknowledgement,
    SequenceExhausted,
}

impl From<crate::BoundedError> for PortableError {
    fn from(error: crate::BoundedError) -> Self {
        Self::Bounded(error)
    }
}

impl From<EditorError> for PortableError {
    fn from(error: EditorError) -> Self {
        Self::Editor(error)
    }
}

/// Worker-issued opening state, including a recovery pause that the page must
/// preserve. Materialize source once at attach, never with each small edit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostSnapshot {
    pub token: SessionToken,
    pub source: String,
    pub revision: Revision,
    pub durable: Revision,
    pub paused: bool,
}

/// One page-local edit may be active. Its view delta is released only after a
/// matching host append acknowledgement. Further input is backpressured rather
/// than queued on a display timer. A failed active draft remains copyable.
pub struct PortableSession {
    engine: EditorSession,
    token: SessionToken,
    sequence: u64,
    waiting: Option<HostRequest>,
    pending: Option<(SourceEdit, ViewChange)>,
    displayed: Revision,
    accepted: Revision,
    durable: Revision,
    paused: bool,
    relink: Option<RelinkOffer>,
    bounded_entry: Option<BoundedModeRequest>,
    bounded_work: crate::BoundedWork,
}

impl PortableSession {
    /// The host supplies exact recovered text/revision and conservative durable
    /// watermark. A token must never be reused for a different attached session.
    pub fn open(token: SessionToken, source: &str, revision: Revision, durable: Revision) -> Self {
        Self::open_with_clock(
            token,
            source,
            revision,
            durable,
            std::sync::Arc::new(crate::history::MonotonicClock::default()),
        )
    }

    pub fn open_with_clock(
        token: SessionToken,
        source: &str,
        revision: Revision,
        durable: Revision,
        clock: std::sync::Arc<dyn crate::HistoryClock>,
    ) -> Self {
        assert!(durable.0 <= revision.0);
        Self {
            engine: EditorSession::restore_with_clock(source, revision, clock),
            token,
            sequence: 0,
            waiting: None,
            pending: None,
            displayed: revision,
            accepted: revision,
            durable,
            paused: false,
            relink: None,
            bounded_entry: None,
            bounded_work: crate::BoundedWork::default(),
        }
    }

    pub fn from_snapshot(snapshot: HostSnapshot) -> Result<Self, PortableError> {
        if snapshot.durable.0 > snapshot.revision.0 {
            return Err(PortableError::InvalidAcknowledgement);
        }
        let mut session = Self::open(
            snapshot.token,
            &snapshot.source,
            snapshot.revision,
            snapshot.durable,
        );
        session.paused = snapshot.paused;
        Ok(session)
    }

    /// Queries cannot expose a locally staged projection before host acceptance.
    pub fn project(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<crate::ProjectionSlice, PortableError> {
        if self.pending.is_some() || self.bounded_entry.is_some() {
            return Err(PortableError::Busy);
        }
        Ok(self.engine.project(expected, range)?)
    }

    pub fn select_with_affinity(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: crate::Affinity,
    ) -> Result<crate::SelectionChange, PortableError> {
        self.ready()?;
        Ok(self
            .engine
            .select_with_affinity(expected, range, affinity)?)
    }

    pub fn active_formats(&self) -> Result<Vec<crate::InlineFormat>, PortableError> {
        self.ready()?;
        Ok(self.engine.active_formats())
    }

    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: crate::InlineFormat,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self.engine.toggle_format(expected, format, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }

    pub fn draft_text(&self) -> String {
        self.engine.source_text()
    }
    pub fn status(&self) -> PortableStatus {
        PortableStatus {
            local: self.engine.revision(),
            displayed: self.displayed,
            accepted: self.accepted,
            durable: self.durable,
            paused: self.paused,
            waiting: self.waiting.is_some() || self.bounded_entry.is_some(),
        }
    }

    fn ready(&self) -> Result<(), PortableError> {
        if self.paused {
            return Err(PortableError::Paused);
        }
        if self.waiting.is_some() || self.pending.is_some() || self.bounded_entry.is_some() {
            return Err(PortableError::Busy);
        }
        if self.sequence == u64::MAX {
            return Err(PortableError::SequenceExhausted);
        }
        Ok(())
    }

    fn request(&mut self, operation: HostOperation) -> Result<HostRequest, PortableError> {
        if self.waiting.is_some() || self.bounded_entry.is_some() {
            return Err(PortableError::Busy);
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or(PortableError::SequenceExhausted)?;
        let request = HostRequest {
            token: self.token,
            sequence: self.sequence,
            operation,
        };
        self.waiting = Some(request.clone());
        Ok(request)
    }

    pub fn block_command_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        command: crate::BlockCommand,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .block_command_utf16(expected, range, command, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }

    pub fn paragraph_key_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        key: crate::ParagraphKey,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .paragraph_key_utf16(expected, range, key, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }

    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<HostRequest, PortableError> {
        self.replace_action(expected, range, inserted, crate::InputAction::Typing)
    }

    pub fn replace_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
    ) -> Result<HostRequest, PortableError> {
        self.ready()?;
        let mut record = None;
        let change =
            self.engine
                .replace_action(expected, range, inserted, action, &mut |edit| {
                    record = Some(edit.clone());
                    Ok(())
                })?;
        self.stage(record.unwrap(), change)
    }

    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[crate::DisplayReplacement],
    ) -> Result<HostRequest, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .replace_many(expected, replacements, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        self.stage(record.unwrap(), change)
    }

    pub fn replace_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<HostRequest, PortableError> {
        self.ready()?;
        let (range, inserted) = self.engine.decode_utf16_input(expected, range, inserted)?;
        self.replace(expected, range, &inserted)
    }

    pub fn replace_utf16_action(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
        action: crate::InputAction,
    ) -> Result<HostRequest, PortableError> {
        self.ready()?;
        let (range, inserted) = self.engine.decode_utf16_input(expected, range, inserted)?;
        self.replace_action(expected, range, &inserted, action)
    }

    pub fn replace_many_utf16(
        &mut self,
        expected: Revision,
        replacements: &[crate::DisplayUtf16Replacement],
    ) -> Result<HostRequest, PortableError> {
        self.ready()?;
        let replacements = self
            .engine
            .decode_utf16_replacements(expected, replacements)?;
        self.replace_many(expected, &replacements)
    }

    pub fn undo(&mut self, expected: Revision) -> Result<Option<HostRequest>, PortableError> {
        self.history(expected, false)
    }
    pub fn redo(&mut self, expected: Revision) -> Result<Option<HostRequest>, PortableError> {
        self.history(expected, true)
    }
    fn history(
        &mut self,
        expected: Revision,
        redo: bool,
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let mut capture = |edit: &SourceEdit| {
            record = Some(edit.clone());
            Ok(())
        };
        let change = if redo {
            self.engine.redo(expected, &mut capture)?
        } else {
            self.engine.undo(expected, &mut capture)?
        };
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }
    fn stage(
        &mut self,
        edit: SourceEdit,
        change: ViewChange,
    ) -> Result<HostRequest, PortableError> {
        let request = self.request(HostOperation::Append(edit.clone()))?;
        self.pending = Some((edit, change));
        self.relink = None;
        Ok(request)
    }

    pub fn flush(&mut self) -> Result<HostRequest, PortableError> {
        self.ready()?;
        self.request(HostOperation::Flush)
    }

    pub fn apply_relink_offer(&mut self) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let Some(offer) = self.relink.take() else {
            return Ok(None);
        };
        if offer.revision != self.engine.revision() || self.engine.composition().is_some() {
            return Ok(None);
        }
        let mut record = None;
        let change = self
            .engine
            .apply_own_relink(offer.revision, &offer.action, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }

    /// Also used after a transport timeout. The host repairs/flushes before
    /// acknowledgement; if it already accepted the active edit, do not resend it.
    pub fn resume(&mut self) -> Result<HostRequest, PortableError> {
        if self.bounded_entry.is_some() {
            return Err(PortableError::Busy);
        }
        self.waiting = None;
        self.paused = true;
        self.request(HostOperation::Resume)
    }

    pub fn retry_pending(&mut self) -> Result<HostRequest, PortableError> {
        if self.paused {
            return Err(PortableError::Paused);
        }
        let edit = self.pending.as_ref().ok_or(PortableError::Busy)?.0.clone();
        self.request(HostOperation::Append(edit))
    }

    /// Duplicate, old-incarnation and superseded replies cannot release a delta
    /// or move watermarks. Invalid matching replies leave the active request intact.
    pub fn acknowledge(&mut self, ack: HostAck) -> Result<Option<ViewChange>, PortableError> {
        let Some(request) = &self.waiting else {
            return Ok(None);
        };
        if ack.token != self.token || ack.sequence != request.sequence {
            return Ok(None);
        }
        let limit = match &request.operation {
            HostOperation::Append(edit) => edit.revision,
            HostOperation::Flush => self.accepted,
            HostOperation::Resume => self.engine.revision(),
        };
        if ack.durable.0 > ack.accepted.0
            || ack.accepted.0 < self.accepted.0
            || ack.durable.0 < self.durable.0
            || ack.accepted.0 > limit.0
        {
            return Err(PortableError::InvalidAcknowledgement);
        }
        if ack.error.is_none() && (!ack.paused) {
            let expected = match &request.operation {
                HostOperation::Append(edit) => Some(edit.revision),
                HostOperation::Flush => Some(self.accepted),
                HostOperation::Resume => None,
            };
            if expected.is_some_and(|expected| ack.accepted != expected)
                || (matches!(
                    request.operation,
                    HostOperation::Flush | HostOperation::Resume
                ) && ack.durable != ack.accepted)
            {
                return Err(PortableError::InvalidAcknowledgement);
            }
        }
        self.waiting = None;
        self.accepted = ack.accepted;
        self.durable = ack.durable;
        self.paused = ack.paused || ack.error.is_some();
        self.relink = ack
            .relink
            .filter(|offer| offer.revision == self.engine.revision());
        if !self.paused
            && self
                .pending
                .as_ref()
                .is_some_and(|(edit, _)| edit.revision == self.accepted)
        {
            let (_, change) = self.pending.take().unwrap();
            self.displayed = change.revision;
            return Ok(Some(change));
        }
        Ok(None)
    }
}
