use futo_notes_editor::{
    EditorError, HostAck, HostOperation, HostRequest, HostSnapshot, SessionToken,
};

use super::{Attachment, EditorStoreError, RecoveryIssue, StoreEditorSession};

/// Worker-owned native endpoint. Move this session to the worker and exchange
/// requests/replies; never call `handle` on the UI thread. It does blocking I/O.
/// It exclusively owns the attached session, so markdown checkpoints cannot
/// silently invalidate its page's revision/identity contract.
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
            // A prepared native relink may still adopt source. Complete that
            // workflow before changing the attachment's source-delivery owner.
            let _gate = self.store.lock_gate().map_err(EditorStoreError::Recovery)?;
            let _vault = futo_notes_core::files::vault_mutation_guard()
                .map_err(EditorStoreError::Recovery)?;
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.terminal {
                return Err(EditorStoreError::SessionDeleted);
            }
            // A failed native transition may still own a captured source
            // adoption. Its retry must finish before a page snapshots source.
            if state.pending_identity.is_some() {
                return Err(EditorStoreError::CheckpointPending);
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
    /// Opening state must be produced on the worker and attached with a fresh
    /// token. In particular a recovery pause must survive page initialization.
    pub fn snapshot(&self) -> HostSnapshot {
        let state = self
            .session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let status = state.recovery_status(&self.session.store);
        HostSnapshot {
            token: self.token,
            source: state.engine.source_text(),
            revision: state.engine.revision(),
            durable: status.durable,
            paused: status.paused,
        }
    }

    /// Native recovery UI consumes the store's typed issue directly, while the
    /// page receives its retained draft and pause through the opening snapshot.
    pub fn recovery_issue(&self) -> Option<RecoveryIssue> {
        self.session.recovery_issue()
    }

    /// Remaining delay from the oldest accepted, unflushed edit; subsequent
    /// appends do not extend it. Arrange a Flush request on this worker when due.
    pub fn recovery_flush_delay(&self) -> Option<std::time::Duration> {
        self.session.recovery_flush_delay()
    }

    pub fn handle(&mut self, request: HostRequest) -> HostAck {
        // Readiness and request receipts share the identity/checkpoint workflow's
        // decision boundary. A healthy pre-gate snapshot cannot authorize input.
        let _gate = match self.session.store.lock_gate() {
            Ok(gate) => gate,
            Err(error) => {
                return self.reply(
                    &request,
                    Some(EditorStoreError::Recovery(error).to_string()),
                )
            }
        };
        let _vault = match futo_notes_core::files::vault_mutation_guard() {
            Ok(vault) => vault,
            Err(error) => {
                return self.reply(
                    &request,
                    Some(EditorStoreError::Recovery(error).to_string()),
                )
            }
        };
        let mut state = self
            .session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.terminal {
            return self.reply_with_state(
                &state,
                &request,
                Some("editor attachment was deleted".into()),
            );
        }
        if request.token != self.token {
            return self.reply_with_state(&state, &request, Some("stale editor session".into()));
        }
        if self
            .sequence_floor
            .is_some_and(|floor| request.sequence <= floor)
        {
            return self.reply_with_state(
                &state,
                &request,
                Some("retired editor mode request".into()),
            );
        }
        if let Some((previous, ack)) = &self.last {
            if *previous == request {
                // Preserve the operation's result without replaying it, but
                // report current recovery health and watermarks after workflows.
                return self.reply_with_state(&state, &request, ack.error.clone());
            }
            if request.sequence <= previous.sequence {
                return self.reply_with_state(
                    &state,
                    &request,
                    Some("stale or conflicting editor request".into()),
                );
            }
        }
        let result = match &request.operation {
            HostOperation::Append(edit) => Self::append(&mut state, &self.session.store, edit),
            HostOperation::Flush => state.flush_recovery(&self.session.store).map(|_| ()),
            HostOperation::Resume => {
                let result = state.resume_recovery(&self.session.store).map(|_| ());
                state.lease.bind(&self.session.state);
                result
            }
        };
        let ack = self.reply_with_state(
            &state,
            &request,
            result.err().map(|error| error.to_string()),
        );
        self.last = Some((request, ack.clone()));
        ack
    }

    fn append(
        state: &mut Attachment,
        store: &crate::LocalNoteStore,
        edit: &futo_notes_editor::SourceEdit,
    ) -> Result<(), EditorStoreError> {
        state.input_ready()?;
        state.relink_offer = None;
        let Attachment {
            engine, recovery, ..
        } = state;
        engine
            .full_mut()?
            .replay_with_accept(edit, &mut |edit| recovery.append(&store.root, edit))
            .map(|_| ())
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                error => EditorStoreError::Editor(error),
            })
    }

    fn reply(&self, request: &HostRequest, error: Option<String>) -> HostAck {
        let state = self
            .session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.reply_with_state(&state, request, error)
    }

    fn reply_with_state(
        &self,
        state: &Attachment,
        request: &HostRequest,
        error: Option<String>,
    ) -> HostAck {
        let status = state.recovery_status(&self.session.store);
        HostAck {
            token: request.token,
            sequence: request.sequence,
            accepted: status.accepted,
            durable: status.durable,
            paused: status.paused,
            error,
            relink: state.relink_offer.clone(),
        }
    }
}
