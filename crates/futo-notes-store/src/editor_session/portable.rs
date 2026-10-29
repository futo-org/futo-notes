use futo_notes_editor::{
    EditorError, HostAck, HostOperation, HostRequest, HostSnapshot, SessionToken,
};

use super::{EditorStoreError, RecoveryIssue, StoreEditorSession};

/// Worker-owned native endpoint. Move this session to the worker and exchange
/// requests/replies; never call `handle` on the UI thread. It does blocking I/O.
/// It exclusively owns the attached session, so markdown checkpoints cannot
/// silently invalidate its page's revision/identity contract.
pub struct StoreEditorHost<'store> {
    session: StoreEditorSession<'store>,
    token: SessionToken,
    last: Option<(HostRequest, HostAck)>,
}

impl<'store> StoreEditorSession<'store> {
    pub fn into_portable_host(self, token: SessionToken) -> StoreEditorHost<'store> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .portable = true;
        StoreEditorHost {
            session: self,
            token,
            last: None,
        }
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
        let status = self.session.recovery_status();
        HostSnapshot {
            token: self.token,
            source: self.session.source_text(),
            revision: self.session.revision(),
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
        if self
            .session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .terminal
        {
            return self.reply(&request, Some("editor attachment was deleted".into()));
        }
        if request.token != self.token {
            return self.reply(&request, Some("stale editor session".into()));
        }
        if let Some((previous, ack)) = &self.last {
            if *previous == request {
                return ack.clone();
            }
            if request.sequence <= previous.sequence {
                return self.reply(&request, Some("stale or conflicting editor request".into()));
            }
        }
        let result = match &request.operation {
            HostOperation::Append(edit) => {
                if self.session.recovery_status().paused {
                    Err(EditorStoreError::RecoveryPaused)
                } else {
                    self.append(edit)
                }
            }
            HostOperation::Flush => self.session.flush_recovery().map(|_| ()),
            HostOperation::Resume => self.session.resume_recovery().map(|_| ()),
        };
        let ack = self.reply(&request, result.err().map(|error| error.to_string()));
        self.last = Some((request, ack.clone()));
        ack
    }

    fn append(&mut self, edit: &futo_notes_editor::SourceEdit) -> Result<(), EditorStoreError> {
        let _gate = self
            .session
            .store
            .lock_gate()
            .map_err(EditorStoreError::Recovery)?;
        let _vault =
            futo_notes_core::files::vault_mutation_guard().map_err(EditorStoreError::Recovery)?;
        let mut state = self
            .session
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.terminal {
            return Err(EditorStoreError::SessionDeleted);
        }
        state.relink_offer = None;
        let super::Attachment {
            engine, recovery, ..
        } = &mut *state;
        engine
            .replay_with_accept(edit, &mut |edit| {
                recovery.append(&self.session.store.root, edit)
            })
            .map(|_| ())
            .map_err(|error| match error {
                EditorError::Persistence(error) => EditorStoreError::RecoveryAppend(error),
                error => EditorStoreError::Editor(error),
            })
    }

    fn reply(&self, request: &HostRequest, error: Option<String>) -> HostAck {
        let status = self.session.recovery_status();
        HostAck {
            token: request.token,
            sequence: request.sequence,
            accepted: status.accepted,
            durable: status.durable,
            paused: status.paused,
            error,
            relink: self
                .session
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .relink_offer
                .clone(),
        }
    }
}
