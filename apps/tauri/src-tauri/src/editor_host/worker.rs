//! The worker thread one attached note lives on: it owns the Store host, so
//! every blocking Store call and the save timer run off the IPC threads.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

use futo_notes_editor::{HostAck, HostRequest, SessionToken};
use futo_notes_store::{
    EditorStoreError, FlushDisposition, LocalNoteStore, PortableSave, StoreEditorHost,
};

use super::{EditorCheckpointError, EditorOpened, EditorOutcome, EditorSaved};

pub(super) type Emit = Arc<dyn Fn(EditorSaved) + Send + Sync>;
type Reply<T> = Sender<Result<T, EditorCheckpointError>>;

pub(super) enum Job {
    Request(HostRequest, Sender<HostAck>),
    Checkpoint(Reply<EditorOutcome>),
    Rename(String, Reply<EditorOutcome>),
    /// Save (or, `discard`, drop) the draft and release the note.
    Close {
        discard: bool,
        reply: Reply<EditorOutcome>,
    },
    /// Save (or drop) the draft, then read the note back into a fresh draft
    /// answering to the token; with an id, only when that is the note attached.
    Reload {
        token: SessionToken,
        only: Option<String>,
        discard: bool,
        reply: Reply<(EditorOutcome, EditorOpened)>,
    },
    /// A store workflow moved the attachment.
    Wake,
    Stop,
}

/// Test automation's hold on every write of the attached note
/// (`editor_hold_saves`, the page's `__notesShellTest.holdSaves`). Only a debug
/// build can set it: a shipped build never holds a save.
#[derive(Clone, Default)]
pub(super) struct SaveHold(Arc<AtomicBool>);

impl SaveHold {
    pub(super) fn set(&self, held: bool) -> Result<(), String> {
        if !cfg!(debug_assertions) {
            return Err("only a debug build can hold saves".to_owned());
        }
        self.0.store(held, Ordering::SeqCst);
        Ok(())
    }

    fn held(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

fn held() -> EditorCheckpointError {
    "saves are held (test hook)".to_owned().into()
}

pub(super) struct Worker {
    pub(super) token: SessionToken,
    jobs: Option<Sender<Job>>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    pub(super) fn open(
        store: Arc<LocalNoteStore>,
        id: String,
        token: SessionToken,
        hold: SaveHold,
        emit: Emit,
    ) -> Result<(Self, EditorOpened), EditorStoreError> {
        let (jobs, inbox) = mpsc::channel::<Job>();
        let wake = jobs.clone();
        let (opened_tx, opened) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("futo-editor-host".to_owned())
            .spawn(move || {
                // Opening state is produced on the worker that will own it.
                let mut host = match store
                    .open_owned_editor(&id)
                    .and_then(|session| session.into_portable_host(token))
                {
                    Ok(host) => host,
                    Err(error) => {
                        let _ = opened_tx.send(Err(error));
                        return;
                    }
                };
                host.on_moved(move || {
                    let _ = wake.send(Job::Wake);
                });
                let _ = opened_tx.send(Ok(opened_state(&host, token)));
                let reported = host.id();
                Run {
                    host,
                    token,
                    stamp: 0,
                    reported,
                    hold,
                    emit,
                }
                .serve(inbox);
            })
            .map_err(|error| {
                EditorStoreError::Open(format!("failed to start editor host: {error}"))
            })?;
        let mut worker = Self {
            token,
            jobs: Some(jobs),
            thread: Some(thread),
        };
        match opened.recv() {
            Ok(Ok(opened)) => Ok((worker, opened)),
            Ok(Err(error)) => Err(error),
            Err(_) => {
                worker.close();
                Err(EditorStoreError::Open(
                    "editor host stopped while opening".to_owned(),
                ))
            }
        }
    }

    pub(super) fn sender(&self) -> Result<Sender<Job>, String> {
        self.jobs
            .clone()
            .ok_or_else(|| "editor host closed".to_owned())
    }

    /// Waits for the worker to drop the Store host, releasing the lease.
    fn close(&mut self) {
        if let Some(jobs) = self.jobs.take() {
            let _ = jobs.send(Job::Stop);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.close();
    }
}

fn opened_state(host: &StoreEditorHost<'_>, token: SessionToken) -> EditorOpened {
    EditorOpened {
        token: token.0,
        note_id: host.id(),
        snapshot: host.snapshot(),
    }
}

struct Run {
    host: StoreEditorHost<'static>,
    token: SessionToken,
    stamp: u64,
    /// The note the last outcome named.
    reported: String,
    hold: SaveHold,
    emit: Emit,
}

impl Run {
    fn outcome(
        &mut self,
        saved: bool,
        parked: bool,
        mutation: Option<futo_notes_store::MutationResult>,
    ) -> EditorOutcome {
        self.stamp += 1;
        self.reported = self.host.id();
        EditorOutcome {
            stamp: self.stamp,
            note_id: self.reported.clone(),
            revision: self.host.revision(),
            saved,
            parked,
            mutation,
            offered: None,
            recreated: false,
            error: None,
        }
    }

    fn saved(&mut self, save: PortableSave) -> EditorOutcome {
        let disposition = save.flush.disposition;
        let parked = matches!(disposition, FlushDisposition::ParkedConflict { .. });
        let mut outcome = self.outcome(true, parked, save.flush.mutation);
        outcome.offered = save.offered;
        outcome.recreated = disposition == FlushDisposition::Recreated;
        outcome
    }

    fn emit(&self, outcome: EditorOutcome) {
        (self.emit)(EditorSaved {
            token: self.token.0,
            outcome,
        });
    }

    fn checkpoint(&mut self) -> Result<EditorOutcome, EditorCheckpointError> {
        if self.hold.held() {
            return Ok(self.outcome(false, false, None));
        }
        let save = self.host.checkpoint()?;
        Ok(self.saved(save))
    }

    fn rename(&mut self, title: &str) -> Result<EditorOutcome, EditorCheckpointError> {
        if self.hold.held() {
            return Err(held());
        }
        let renamed = self.host.rename_title(title)?;
        Ok(self.outcome(true, renamed.parked_id.is_some(), Some(renamed.mutation)))
    }

    fn close(&mut self, discard: bool) -> Result<EditorOutcome, EditorCheckpointError> {
        if discard {
            self.host.discard();
            return Ok(self.outcome(false, false, None));
        }
        if self.hold.held() {
            return Err(held());
        }
        let flush = self.host.close()?;
        Ok(self.saved(PortableSave {
            flush,
            offered: None,
        }))
    }

    fn reload(
        &mut self,
        token: SessionToken,
        only: Option<String>,
        discard: bool,
    ) -> Result<(EditorOutcome, EditorOpened), EditorCheckpointError> {
        // The same file: on a case-sensitive vault `Plan` and `plan` are two notes.
        if only.is_some_and(|id| !self.host.holds(&id)) {
            return Err("another note is attached to the editor".to_owned().into());
        }
        if self.hold.held() && !discard {
            return Err(held());
        }
        // The old token's last outcome; the fresh draft's stamps start over.
        let outcome = match self.host.reload(token, discard)? {
            Some(flush) => self.saved(PortableSave {
                flush,
                offered: None,
            }),
            None => self.outcome(false, false, None),
        };
        self.token = token;
        self.stamp = 0;
        Ok((outcome, opened_state(&self.host, token)))
    }

    /// Answers jobs in arrival order and saves when the Store says one is due.
    fn serve(mut self, inbox: Receiver<Job>) {
        // Whether the last job or timeout was answered under a hold. Read before
        // the reply goes out, so a release that follows the reply cannot re-arm
        // the timer in the gap before the next wait.
        let mut answered_held = false;
        loop {
            // Held, nothing is due: after a release the next job re-arms the timer.
            let deadline = (!answered_held && !self.hold.held())
                .then(|| self.host.save_delay())
                .flatten()
                .map(|delay| Instant::now() + delay);
            let job = match deadline {
                Some(at) => inbox.recv_timeout(at.saturating_duration_since(Instant::now())),
                None => inbox.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            answered_held = self.hold.held();
            match job {
                Ok(Job::Request(request, reply)) => {
                    let _ = reply.send(self.host.handle(request));
                }
                Ok(Job::Checkpoint(reply)) => {
                    let _ = reply.send(self.checkpoint());
                }
                Ok(Job::Rename(wanted_id, reply)) => {
                    let _ = reply.send(self.rename(&wanted_id));
                }
                Ok(Job::Close { discard, reply }) => {
                    let result = self.close(discard);
                    let closed = result.is_ok();
                    let _ = reply.send(result);
                    if closed {
                        return;
                    }
                }
                Ok(Job::Reload {
                    token,
                    only,
                    discard,
                    reply,
                }) => {
                    let _ = reply.send(self.reload(token, only, discard));
                }
                Ok(Job::Wake) => {
                    if self.host.id() != self.reported {
                        let moved = self.outcome(false, false, None);
                        self.emit(moved);
                    }
                }
                // A hold that began while this wait ran.
                Err(RecvTimeoutError::Timeout) if self.hold.held() => {}
                Err(RecvTimeoutError::Timeout) => match self.host.save_if_due() {
                    Ok(Some(save)) => {
                        let saved = self.saved(save);
                        self.emit(saved);
                    }
                    Ok(None) => {}
                    // The Store reschedules a failed save; keep going. Stamped like
                    // any outcome, so the page orders it against the saves.
                    Err(error) => {
                        let mut failed = self.outcome(false, false, None);
                        failed.error = Some(error.to_string());
                        self.emit(failed);
                    }
                },
                Ok(Job::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        // The page is gone (or the app is exiting): save before the lease
        // drops. Nobody is left to tell, so a failure is logged: the unsaved
        // edits are lost.
        if self.hold.held() {
            self.host.discard();
        } else if let Err(error) = self.host.close() {
            futo_notes_core::log_to_stderr!(
                "futo-editor-host: closing note {:?} failed, unsaved edits are lost: {error}",
                self.host.id()
            );
        }
    }
}
