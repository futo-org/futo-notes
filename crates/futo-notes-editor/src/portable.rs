//! Page/worker contract. The page applies every edit at once and sends the
//! worker a request to mirror it; acknowledgements arrive later and never gate
//! the page. No callback here performs I/O.
mod clipboard;
mod composition;
mod find;
mod images;
mod links;
mod tables;
mod tags;
mod wikilink_completion;
use serde::{Deserialize, Serialize};
pub use tables::PortableTableStep;

use crate::{
    DisplayRange, DisplayUtf16Range, EditorError, EditorSession, Revision, SourceEdit, ViewChange,
};

/// Host-issued incarnation, unique across note switches and page reloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionToken(pub u64);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostOperation {
    Append(SourceEdit),
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
    pub paused: bool,
    pub error: Option<HostError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relink: Option<RelinkOffer>,
}

/// Why the host refused or failed a request. The kind is for control flow;
/// the message is for logs only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostErrorKind {
    /// The note was deleted; the attachment is terminal.
    Deleted,
    /// Token, sequence or retired-mode mismatch: the request is not for this attachment.
    StaleToken,
    /// The engine rejected the edit itself.
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostError {
    pub kind: HostErrorKind,
    pub message: String,
}

impl HostError {
    pub fn new(kind: HostErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// A successful own-action relink may be adopted only while the page still
/// holds its exact acknowledged source revision. Adoption uses normal append
/// acceptance before releasing its view change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelinkOffer {
    pub revision: Revision,
    /// The store's exact rewritten note bytes.
    pub source: String,
}

impl HostRequest {
    pub fn accepted(&self, accepted: Revision) -> HostAck {
        HostAck {
            token: self.token,
            sequence: self.sequence,
            accepted,
            paused: false,
            error: None,
            relink: None,
        }
    }
}

/// One applied input: the view change to show now and the request the caller
/// must send to the worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Applied {
    pub change: ViewChange,
    pub request: HostRequest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableStatus {
    /// The page's current revision.
    pub local: Revision,
    /// The newest revision the worker has acknowledged.
    pub accepted: Revision,
    pub paused: bool,
    /// Edit requests sent but not yet acknowledged.
    pub outstanding: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortableError {
    Editor(EditorError),
    Paused,
    InvalidAcknowledgement,
    SequenceExhausted,
}

impl From<EditorError> for PortableError {
    fn from(error: EditorError) -> Self {
        Self::Editor(error)
    }
}

/// Worker-issued opening state, including a pause that the page must preserve. Materialize source once at attach, never with each small edit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostSnapshot {
    pub token: SessionToken,
    pub source: String,
    pub revision: Revision,
    pub paused: bool,
}

/// Edits apply to the page's engine immediately. Each returns its view change
/// together with a request carrying the next sequence number; any number may be
/// outstanding. Queries, selection and composition never wait on
/// acknowledgements. An error acknowledgement pauses the page: input is refused
/// and the draft stays copyable.
pub struct PortableSession {
    engine: EditorSession,
    token: SessionToken,
    sequence: u64,
    /// Sent edit requests not yet acknowledged, in sequence order.
    outstanding: std::collections::VecDeque<HostRequest>,
    /// The sequence of the `Resume` request awaiting its reply.
    resuming: Option<u64>,
    accepted: Revision,
    paused: bool,
    relink: Option<RelinkOffer>,
}

impl PortableSession {
    /// The host supplies the exact opening text and revision. A token must never be reused for a different attached session.
    pub fn open(token: SessionToken, source: &str, revision: Revision) -> Self {
        Self::open_with_clock(
            token,
            source,
            revision,
            std::sync::Arc::new(crate::history::MonotonicClock::default()),
        )
    }

    pub fn open_with_clock(
        token: SessionToken,
        source: &str,
        revision: Revision,
        clock: std::sync::Arc<dyn crate::HistoryClock>,
    ) -> Self {
        Self {
            engine: EditorSession::restore_with_clock(source, revision, clock),
            token,
            sequence: 0,
            outstanding: std::collections::VecDeque::new(),
            resuming: None,
            accepted: revision,
            paused: false,
            relink: None,
        }
    }

    pub fn from_snapshot(snapshot: HostSnapshot) -> Result<Self, PortableError> {
        Self::from_snapshot_with_clock(
            snapshot,
            std::sync::Arc::new(crate::history::MonotonicClock::default()),
        )
    }

    pub fn from_snapshot_with_clock(
        snapshot: HostSnapshot,
        clock: std::sync::Arc<dyn crate::HistoryClock>,
    ) -> Result<Self, PortableError> {
        let mut session =
            Self::open_with_clock(snapshot.token, &snapshot.source, snapshot.revision, clock);
        session.paused = snapshot.paused;
        Ok(session)
    }

    pub fn project(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<crate::ProjectionSlice, PortableError> {
        Ok(self.engine.project(expected, range)?)
    }

    /// Display byte range to UTF-16 units.
    pub fn display_to_utf16(
        &self,
        expected: Revision,
        range: DisplayRange,
    ) -> Result<DisplayUtf16Range, PortableError> {
        Ok(self.engine.display_to_utf16(expected, range)?)
    }

    /// Inverse of `display_to_utf16`; rejects mid-surrogate and mid-char offsets.
    pub fn utf16_to_display(
        &self,
        expected: Revision,
        range: DisplayUtf16Range,
    ) -> Result<DisplayRange, PortableError> {
        Ok(self.engine.display_from_utf16(expected, range)?)
    }

    pub fn select_with_affinity(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        affinity: crate::Affinity,
    ) -> Result<crate::SelectionChange, PortableError> {
        Ok(self
            .engine
            .select_with_affinity(expected, range, affinity)?)
    }

    pub fn active_formats(&self) -> Result<Vec<crate::InlineFormat>, PortableError> {
        Ok(self.engine.active_formats())
    }

    pub fn toggle_format(
        &mut self,
        expected: Revision,
        format: crate::InlineFormat,
    ) -> Result<Option<Applied>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self.engine.toggle_format(expected, format, &mut |edit| {
            record = Some(edit.clone());
            Ok(())
        })?;
        Ok(change.map(|change| self.issue(record.unwrap(), change)))
    }

    pub fn draft_text(&self) -> String {
        self.engine.source_text()
    }
    pub fn status(&self) -> PortableStatus {
        PortableStatus {
            local: self.engine.revision(),
            accepted: self.accepted,
            paused: self.paused,
            outstanding: self.outstanding.len(),
        }
    }

    /// Input is refused while paused or once sequence numbers run out.
    fn ready(&self) -> Result<(), PortableError> {
        if self.paused {
            return Err(PortableError::Paused);
        }
        if self.sequence == u64::MAX {
            return Err(PortableError::SequenceExhausted);
        }
        Ok(())
    }

    fn next_request(&mut self, operation: HostOperation) -> HostRequest {
        self.sequence += 1;
        HostRequest {
            token: self.token,
            sequence: self.sequence,
            operation,
        }
    }

    pub fn block_command_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        command: crate::BlockCommand,
    ) -> Result<Option<Applied>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .block_command_utf16(expected, range, command, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        Ok(change.map(|change| self.issue(record.unwrap(), change)))
    }

    pub fn paragraph_key_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        key: crate::ParagraphKey,
    ) -> Result<Option<Applied>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .paragraph_key_utf16(expected, range, key, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        Ok(change.map(|change| self.issue(record.unwrap(), change)))
    }

    pub fn replace(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
    ) -> Result<Applied, PortableError> {
        self.replace_action(expected, range, inserted, crate::InputAction::Typing)
    }

    pub fn replace_action(
        &mut self,
        expected: Revision,
        range: DisplayRange,
        inserted: &str,
        action: crate::InputAction,
    ) -> Result<Applied, PortableError> {
        self.ready()?;
        let mut record = None;
        let change =
            self.engine
                .replace_action(expected, range, inserted, action, &mut |edit| {
                    record = Some(edit.clone());
                    Ok(())
                })?;
        Ok(self.issue(record.unwrap(), change))
    }

    pub fn replace_many(
        &mut self,
        expected: Revision,
        replacements: &[crate::DisplayReplacement],
    ) -> Result<Applied, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .replace_many(expected, replacements, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        Ok(self.issue(record.unwrap(), change))
    }

    pub fn replace_utf16(
        &mut self,
        expected: Revision,
        range: DisplayUtf16Range,
        inserted: &[u16],
    ) -> Result<Applied, PortableError> {
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
    ) -> Result<Applied, PortableError> {
        self.ready()?;
        let (range, inserted) = self.engine.decode_utf16_input(expected, range, inserted)?;
        self.replace_action(expected, range, &inserted, action)
    }

    pub fn replace_many_utf16(
        &mut self,
        expected: Revision,
        replacements: &[crate::DisplayUtf16Replacement],
    ) -> Result<Applied, PortableError> {
        self.ready()?;
        let replacements = self
            .engine
            .decode_utf16_replacements(expected, replacements)?;
        self.replace_many(expected, &replacements)
    }

    pub fn undo(&mut self, expected: Revision) -> Result<Option<Applied>, PortableError> {
        self.history(expected, false)
    }
    pub fn redo(&mut self, expected: Revision) -> Result<Option<Applied>, PortableError> {
        self.history(expected, true)
    }
    fn history(
        &mut self,
        expected: Revision,
        redo: bool,
    ) -> Result<Option<Applied>, PortableError> {
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
        Ok(change.map(|change| self.issue(record.unwrap(), change)))
    }
    /// Record an edit the engine already applied and issue its request.
    /// `ready` has checked the sequence, so numbering cannot overflow here.
    fn issue(&mut self, edit: SourceEdit, change: ViewChange) -> Applied {
        let request = self.next_request(HostOperation::Append(edit));
        self.outstanding.push_back(request.clone());
        self.relink = None;
        Applied { change, request }
    }

    /// Explicitly adopt an opt-in merge flush's authoritative source while
    /// retaining local Undo. The host mirrors this as an ordinary source edit;
    /// it must never independently advance the page's revision during saving.
    /// The caller settles marked text first and verifies the flush's revision.
    pub fn adopt_merged_source(
        &mut self,
        expected: Revision,
        source: &str,
    ) -> Result<Applied, PortableError> {
        self.ready()?;
        let adoption = self.engine.prepare_external_source(expected, source)?;
        let edit = adoption.edit.clone();
        // On the core, a merge equal to the page's own text changes nothing
        // and has no Append to send (the worker refuses an empty record).
        #[cfg(feature = "engine")]
        if edit.revision == edit.previous_revision {
            return Err(EditorError::UnrepresentableFormat.into());
        }
        let change = self.engine.apply_external_source(adoption)?;
        Ok(self.issue(edit, change))
    }

    /// Adopt the worker's relink offer when the page still holds exactly the
    /// offered revision; a stale offer is dropped.
    pub fn apply_relink_offer(&mut self) -> Result<Option<Applied>, PortableError> {
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
            .apply_own_relink(offer.revision, &offer.source, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        Ok(change.map(|change| self.issue(record.unwrap(), change)))
    }

    /// Ask the worker for its current state; also the way out of a pause.
    /// Nothing is re-sent here: the reply to this request (see `acknowledge`)
    /// returns the outstanding requests the worker is missing.
    pub fn resume(&mut self) -> Result<HostRequest, PortableError> {
        if self.sequence == u64::MAX {
            return Err(PortableError::SequenceExhausted);
        }
        self.paused = true;
        let request = self.next_request(HostOperation::Resume);
        self.resuming = Some(request.sequence);
        Ok(request)
    }

    /// Duplicate, old-incarnation and unknown replies change nothing. A success
    /// advances `accepted` and releases no view change: the view already shows
    /// the edit. An error pauses the page. The reply to `resume` returns the
    /// outstanding requests the worker has not accepted, renumbered after the
    /// resume request and in order; every other reply returns none.
    pub fn acknowledge(&mut self, ack: HostAck) -> Result<Vec<HostRequest>, PortableError> {
        if ack.token != self.token {
            return Ok(Vec::new());
        }
        let resume = self.resuming == Some(ack.sequence);
        let edit_revision = self
            .outstanding
            .iter()
            .find(|request| request.sequence == ack.sequence)
            .map(|request| match &request.operation {
                HostOperation::Append(edit) => edit.revision,
                HostOperation::Resume => unreachable!("resume is never outstanding"),
            });
        if !resume && edit_revision.is_none() {
            return Ok(Vec::new());
        }
        if ack.accepted.0 < self.accepted.0 || ack.accepted.0 > self.engine.revision().0 {
            return Err(PortableError::InvalidAcknowledgement);
        }
        let failed = ack.paused || ack.error.is_some();
        if !failed && edit_revision.is_some_and(|revision| ack.accepted != revision) {
            return Err(PortableError::InvalidAcknowledgement);
        }
        if resume {
            self.resuming = None;
        }
        self.accepted = ack.accepted;
        self.paused = failed;
        self.outstanding.retain(|request| match &request.operation {
            HostOperation::Append(edit) => edit.revision.0 > ack.accepted.0,
            HostOperation::Resume => false,
        });
        self.relink = ack
            .relink
            .filter(|offer| offer.revision == self.engine.revision());
        if !resume || failed {
            return Ok(Vec::new());
        }
        let count = self.outstanding.len() as u64;
        if self.sequence.checked_add(count).is_none() {
            return Err(PortableError::SequenceExhausted);
        }
        let mut resent = Vec::with_capacity(self.outstanding.len());
        for request in self.outstanding.iter_mut() {
            self.sequence += 1;
            request.sequence = self.sequence;
            resent.push(request.clone());
        }
        Ok(resent)
    }
}
