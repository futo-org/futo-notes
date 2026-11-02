use futo_notes_editor::{
    HostAck, HostError, HostErrorKind, HostOperation, HostRequest, HostSnapshot, SessionToken,
};

use super::{Attachment, EditorStoreError, StoreEditorSession};

/// Worker-owned native endpoint. Move this session to the worker and exchange
/// requests/replies; never call `handle` on the UI thread (it takes the attachment
/// lock, which a checkpoint on this worker can hold). The worker's timer calls `save_if_due`. The host exclusively owns the
/// attached session, so markdown saves cannot silently invalidate its page's
/// revision/identity contract.
pub struct StoreEditorHost<'store> {
    pub(super) session: StoreEditorSession<'store>,
    pub(super) token: SessionToken,
    pub(super) sequence_floor: Option<u64>,
    pub(super) last: Option<(HostRequest, HostAck)>,
}

impl<'store> StoreEditorSession<'store> {
    pub fn into_portable_host(
        self,
        token: SessionToken,
    ) -> Result<StoreEditorHost<'store>, EditorStoreError> {
        {
            let _gate = self.store.lock_gate().map_err(EditorStoreError::Open)?;
            let _vault =
                futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Open)?;
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.terminal {
                return Err(EditorStoreError::SessionDeleted);
            }
            state.portable = true;
        }
        Ok(StoreEditorHost {
            session: self,
            token,
            last: None,
            sequence_floor: None,
        })
    }
}

impl StoreEditorHost<'_> {
    pub fn checkpoint(&mut self) -> Result<crate::FlushDraftResult, EditorStoreError> {
        self.session.checkpoint()
    }

    pub fn id(&self) -> String {
        self.session.id()
    }

    /// Time left until the next save is due; see `StoreEditorSession::save_delay`.
    pub fn save_delay(&self) -> Option<std::time::Duration> {
        self.session.save_delay()
    }

    pub fn save_if_due(&mut self) -> Result<Option<crate::FlushDraftResult>, EditorStoreError> {
        self.session.save_if_due()
    }

    /// Save and release the attachment; a failed save leaves it attached.
    pub fn close(&mut self) -> Result<crate::FlushDraftResult, EditorStoreError> {
        self.session.close()
    }

    /// Opening state must be produced on the worker and attached with a fresh
    /// token. A paused attachment stays paused through page initialization.
    pub fn snapshot(&self) -> HostSnapshot {
        let state = self
            .session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        HostSnapshot {
            token: self.token,
            source: state.engine.source_text(),
            revision: state.engine.revision(),
            paused: state.terminal,
        }
    }

    pub fn handle(&mut self, request: HostRequest) -> HostAck {
        // Only the attachment lock: input never waits on the store gate. The
        // lock makes the sequence check and the replay one decision.
        let mut state = self
            .session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.terminal {
            return self.reply_with_state(
                &state,
                &request,
                Some(HostError::new(
                    HostErrorKind::Deleted,
                    "editor attachment was deleted",
                )),
            );
        }
        if request.token != self.token {
            return self.reply_with_state(
                &state,
                &request,
                Some(HostError::new(
                    HostErrorKind::StaleToken,
                    "stale editor session",
                )),
            );
        }
        if self
            .sequence_floor
            .is_some_and(|floor| request.sequence <= floor)
        {
            return self.reply_with_state(
                &state,
                &request,
                Some(HostError::new(
                    HostErrorKind::StaleToken,
                    "retired editor mode request",
                )),
            );
        }
        if let Some((previous, ack)) = &self.last {
            if *previous == request {
                // A duplicate of the last request is idempotent: report its
                // original result without replaying it.
                return self.reply_with_state(&state, &request, ack.error.clone());
            }
        }
        // Edits must arrive exactly in order. A resume is a state query that
        // also restarts the page's numbering, so any newer number is fine.
        let last = self
            .last
            .as_ref()
            .map_or(0, |(previous, _)| previous.sequence);
        let in_order = match request.operation {
            HostOperation::Append(_) => request.sequence == last.saturating_add(1),
            HostOperation::Resume => request.sequence > last,
        };
        if !in_order {
            return self.reply_with_state(
                &state,
                &request,
                Some(HostError::new(
                    HostErrorKind::Rejected,
                    format!(
                        "request sequence {} is out of order after {last}",
                        request.sequence
                    ),
                )),
            );
        }
        let result = match &request.operation {
            HostOperation::Append(edit) => Self::append(&mut state, edit),
            // The worker's state is always current: resume only reports it
            // (including a pending relink offer).
            HostOperation::Resume => Ok(()),
        };
        let ack = self.reply_with_state(&state, &request, result.err().map(HostError::from));
        self.last = Some((request, ack.clone()));
        ack
    }

    fn append(
        state: &mut Attachment,
        edit: &futo_notes_editor::SourceEdit,
    ) -> Result<(), EditorStoreError> {
        state.input_ready()?;
        state.relink_offer = None;
        let before = state.engine.revision();
        let result = state
            .engine
            .replay_with_accept(edit, &mut super::save::no_accept)
            .map(|_| ())
            .map_err(EditorStoreError::Editor);
        if state.engine.revision() != before {
            state.note_edit();
        }
        result
    }

    fn reply_with_state(
        &self,
        state: &Attachment,
        request: &HostRequest,
        error: Option<HostError>,
    ) -> HostAck {
        HostAck {
            token: request.token,
            sequence: request.sequence,
            accepted: state.engine.revision(),
            paused: state.terminal,
            error,
            relink: state.relink_offer.clone(),
        }
    }
}

impl From<EditorStoreError> for HostError {
    fn from(error: EditorStoreError) -> Self {
        use EditorStoreError as E;
        let kind = match &error {
            E::SessionDeleted => HostErrorKind::Deleted,
            E::Editor(_) | E::SessionAlreadyOpen | E::Open(_) | E::Checkpoint(_) => {
                HostErrorKind::Rejected
            }
        };
        Self::new(kind, error.to_string())
    }
}
