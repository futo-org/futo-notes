use super::*;
use futo_notes_editor::{
    BoundedHostAck, BoundedHostOperation, BoundedHostRequest, BoundedModeReady, BoundedModeRequest,
    BoundedSourceAuthority, BoundedWork, HostAck, HostRequest,
};

/// Source-only worker. It can return only to the legacy portable host, whose
/// methods do not expose native Undo/Redo or worker presentation coordinates.
pub struct StoreBoundedEditorHost<'store> {
    session: StoreEditorSession<'store>,
    ready: BoundedModeReady,
    last: Option<(BoundedHostRequest, BoundedHostAck)>,
    prior: (Option<(HostRequest, HostAck)>, Option<u64>),
    committed: bool,
}
pub struct StoreBoundedHostEntryError<'store> {
    pub host: Box<StoreEditorHost<'store>>,
    pub error: EditorStoreError,
    pub work: BoundedWork,
}
pub struct StoreBoundedHostExitError<'store> {
    pub host: Box<StoreBoundedEditorHost<'store>>,
    pub error: EditorStoreError,
    pub work: BoundedWork,
}
impl std::fmt::Debug for StoreBoundedHostEntryError<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}
impl std::fmt::Debug for StoreBoundedHostExitError<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}

impl<'store> StoreEditorHost<'store> {
    pub fn last_bounded_operation_work(&self) -> BoundedWork {
        self.session.last_bounded_operation_work()
    }
    pub fn begin_bounded_entry(
        self,
        request: BoundedModeRequest,
    ) -> Result<StoreBoundedEditorHost<'store>, StoreBoundedHostEntryError<'store>> {
        self.session.reset_bounded_operation_work();
        let floor = self
            .last
            .as_ref()
            .map(|(request, _)| request.sequence)
            .or(self.sequence_floor);
        let result = if request.token != self.token
            || floor.is_some_and(|floor| request.sequence <= floor)
        {
            Err(EditorStoreError::Recovery(
                "stale bounded mode handshake".into(),
            ))
        } else {
            self.session
                .enter_bounded(request.revision, request.token, request.body_caret, true)
        };
        let (cursor, durable) = match result {
            Ok(authority) => authority,
            Err(error) => {
                return Err(StoreBoundedHostEntryError {
                    work: self.session.last_bounded_operation_work(),
                    host: Box::new(self),
                    error,
                })
            }
        };
        // The entry receipt is captured under the same Store/vault/attachment
        // decision boundary. A later registry reset is reported by handle.
        let ready = BoundedModeReady {
            request,
            incarnation: cursor.incarnation,
            durable,
        };
        Ok(StoreBoundedEditorHost {
            session: self.session,
            ready,
            last: None,
            prior: (self.last, self.sequence_floor),
            committed: false,
        })
    }
}
impl<'store> StoreBoundedEditorHost<'store> {
    pub fn last_operation_work(&self) -> BoundedWork {
        self.session.last_bounded_operation_work()
    }
    pub fn ready(&self) -> BoundedModeReady {
        self.ready.clone()
    }
    pub fn id(&self) -> String {
        self.session.id()
    }
    pub fn source_text(&self) -> String {
        self.session.source_text()
    }
    pub fn recovery_status(&self) -> RecoveryStatus {
        self.session.recovery_status()
    }
    pub fn recovery_flush_delay(&self) -> Option<Duration> {
        self.session.recovery_flush_delay()
    }

    /// Only an uncommitted handshake may restore old cached Full receipts.
    /// The page cancels its matching entry; no bounded request has run.
    pub fn cancel_bounded_entry(
        self,
    ) -> Result<StoreEditorHost<'store>, StoreBoundedHostExitError<'store>> {
        self.leave(false)
    }
    pub fn into_full(self) -> Result<StoreEditorHost<'store>, StoreBoundedHostExitError<'store>> {
        self.leave(true)
    }
    fn leave(
        self,
        commit: bool,
    ) -> Result<StoreEditorHost<'store>, StoreBoundedHostExitError<'store>> {
        self.session.reset_bounded_operation_work();
        if !commit && self.committed {
            return Err(StoreBoundedHostExitError {
                work: self.session.last_bounded_operation_work(),
                host: Box::new(self),
                error: EditorStoreError::ModeResetRequired,
            });
        }
        let result = (|| {
            let _gate = self
                .session
                .store
                .lock_gate()
                .map_err(EditorStoreError::Recovery)?;
            let _vault = futo_notes_core::files::vault_mutation_guard()
                .map_err(EditorStoreError::Recovery)?;
            let mut state = self
                .session
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            state.input_ready()?;
            state
                .materializing_reset(&self.session.store.root)
                .map_err(EditorStoreError::Recovery)?;
            Ok(())
        })();
        if let Err(error) = result {
            return Err(StoreBoundedHostExitError {
                work: self.session.last_bounded_operation_work(),
                host: Box::new(self),
                error,
            });
        }
        let sequence_floor = if commit {
            Some(
                self.last
                    .as_ref()
                    .map_or(self.ready.request.sequence, |(request, _)| request.sequence),
            )
        } else {
            self.prior.1
        };
        Ok(StoreEditorHost {
            session: self.session,
            token: self.ready.request.token,
            sequence_floor,
            last: if commit { None } else { self.prior.0 },
        })
    }
    pub fn handle(&mut self, request: BoundedHostRequest) -> BoundedHostAck {
        self.session.reset_bounded_operation_work();
        let _gate = match self.session.store.lock_gate() {
            Ok(gate) => gate,
            Err(error) => return self.reply(&request, Some(error), BoundedWork::default()),
        };
        let _vault = match futo_notes_core::files::vault_mutation_guard() {
            Ok(vault) => vault,
            Err(error) => return self.reply(&request, Some(error), BoundedWork::default()),
        };
        let mut state = self
            .session
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if state.terminal {
            return self.reply_state(
                &state,
                &request,
                Some("editor attachment was deleted".into()),
                BoundedWork::default(),
            );
        }
        if request.token != self.ready.request.token
            || request.incarnation != self.ready.incarnation
        {
            return self.reply_state(
                &state,
                &request,
                Some("stale bounded editor mode".into()),
                BoundedWork::default(),
            );
        }
        if request.sequence <= self.ready.request.sequence {
            return self.reply_state(
                &state,
                &request,
                Some("stale bounded request".into()),
                BoundedWork::default(),
            );
        }
        if let Some((previous, ack)) = &self.last {
            if *previous == request {
                state.bounded_work = ack.work;
                return self.reply_state(&state, &request, ack.error.clone(), ack.work);
            }
            if request.sequence <= previous.sequence {
                return self.reply_state(
                    &state,
                    &request,
                    Some("stale or conflicting bounded request".into()),
                    BoundedWork::default(),
                );
            }
        }
        self.committed = true;
        let mut work = BoundedWork::default();
        let result = (|| match &request.operation {
            BoundedHostOperation::Append { edit, operation } => {
                state.input_ready()?;
                let Attachment {
                    engine, recovery, ..
                } = &mut *state;
                let engine = engine.source_worker_mut()?;
                let result = engine.replay_bounded_source(
                    BoundedSourceAuthority {
                        token: request.token,
                        incarnation: request.incarnation,
                        revision: edit.previous_revision,
                    },
                    edit,
                    operation,
                    &mut |edit| recovery.append(&self.session.store.root, edit),
                );
                work = engine.last_operation_work();
                result.map_err(owner::bounded_error)
            }
            BoundedHostOperation::Flush => {
                state.engine.source_worker()?;
                state.flush_recovery(&self.session.store)?;
                Ok(BoundedWork::default())
            }
            BoundedHostOperation::Resume => {
                state.engine.source_worker()?;
                state.resume_recovery(&self.session.store)?;
                state.lease.bind(&self.session.state);
                Ok(BoundedWork::default())
            }
        })();
        let (work, error) = match result {
            Ok(work) => (work, None),
            Err(error) => (work, Some(error.to_string())),
        };
        state.bounded_work = work;
        let ack = self.reply_state(&state, &request, error, work);
        self.last = Some((request, ack.clone()));
        ack
    }
    fn reply(
        &self,
        request: &BoundedHostRequest,
        error: Option<String>,
        work: BoundedWork,
    ) -> BoundedHostAck {
        let state = self
            .session
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        self.reply_state(&state, request, error, work)
    }
    fn reply_state(
        &self,
        state: &Attachment,
        request: &BoundedHostRequest,
        error: Option<String>,
        work: BoundedWork,
    ) -> BoundedHostAck {
        let status = state.recovery_status();
        BoundedHostAck {
            token: request.token,
            incarnation: request.incarnation,
            sequence: request.sequence,
            accepted: status.accepted,
            durable: status.durable,
            paused: status.paused,
            reset_required: state.engine.source_worker().is_err(),
            error,
            work,
        }
    }
}
