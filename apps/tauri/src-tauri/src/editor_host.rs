//! Desktop host for the text-first editor's portable (WASM) page (#283).
//!
//! The page owns a `WasmSession` and emits one ordered `HostRequest` at a time;
//! this module routes each to a dedicated worker thread that owns the note's
//! `StoreEditorHost` and answers with the Store's `HostAck`. One note is
//! attached at a time; opening another closes the current one first.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use futo_notes_editor::{HostAck, HostRequest, HostSnapshot, SessionToken};
use futo_notes_store::{EditorStoreError, FlushDraftResult, LocalNoteStore};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::application_state::AppState;
use crate::background_tasks::{blocking, join_error};

/// Emitted by the worker each time its save timer fires and writes (or fails
/// to write) the note's markdown. Payload: [`EditorSaved`]. The page applies
/// `result`'s mutation like any other save; on `error` it keeps typing, since
/// the Store retries on its own schedule.
pub(crate) const SAVED_EVENT: &str = "editor:saved";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorSaved {
    pub(crate) token: u64,
    pub(crate) result: Option<FlushDraftResult>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorOpened {
    pub(crate) token: u64,
    /// Feed to `WasmSession.restore`.
    pub(crate) snapshot: HostSnapshot,
    /// For the page's first `update_note_ids`.
    pub(crate) note_ids: Vec<String>,
}

/// Why `editor_checkpoint` did not complete. The session stays attached and
/// accepting input; the page may retry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum EditorCheckpointError {
    Failed { message: String },
}

impl From<String> for EditorCheckpointError {
    fn from(message: String) -> Self {
        Self::Failed { message }
    }
}

impl From<EditorStoreError> for EditorCheckpointError {
    fn from(error: EditorStoreError) -> Self {
        Self::Failed {
            message: error.to_string(),
        }
    }
}

enum Job {
    Request(HostRequest, Sender<HostAck>),
    Checkpoint(Sender<Result<FlushDraftResult, EditorCheckpointError>>),
    Close(Sender<Result<FlushDraftResult, EditorCheckpointError>>),
}

/// One attached note: its worker thread exclusively owns the Store host, so
/// every blocking Store call and the save timer run off the IPC threads.
struct Worker {
    token: SessionToken,
    jobs: Option<Sender<Job>>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    fn open(
        store: Arc<LocalNoteStore>,
        id: String,
        token: SessionToken,
        saved: impl Fn(EditorSaved) + Send + 'static,
    ) -> Result<(Self, EditorOpened), String> {
        let (jobs, inbox) = mpsc::channel::<Job>();
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
                        let _ = opened_tx.send(Err(error.to_string()));
                        return;
                    }
                };
                let _ = opened_tx.send(Ok(EditorOpened {
                    token: token.0,
                    snapshot: host.snapshot(),
                    note_ids: note_ids(&store),
                }));
                let mut closed = false;
                let mut deadline = host.save_delay().map(|delay| Instant::now() + delay);
                loop {
                    let job = match deadline {
                        Some(at) => {
                            inbox.recv_timeout(at.saturating_duration_since(Instant::now()))
                        }
                        None => inbox.recv().map_err(|_| RecvTimeoutError::Disconnected),
                    };
                    match job {
                        Ok(Job::Request(request, reply)) => {
                            let _ = reply.send(host.handle(request));
                        }
                        Ok(Job::Checkpoint(reply)) => {
                            let _ = reply.send(host.checkpoint().map_err(Into::into));
                        }
                        Ok(Job::Close(reply)) => {
                            let result = host.close();
                            closed = result.is_ok();
                            let _ = reply.send(result.map_err(Into::into));
                            if closed {
                                break;
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => match host.save_if_due() {
                            Ok(Some(result)) => saved(EditorSaved {
                                token: token.0,
                                result: Some(result),
                                error: None,
                            }),
                            Ok(None) => {}
                            // The Store reschedules a failed save; keep going.
                            Err(error) => saved(EditorSaved {
                                token: token.0,
                                result: None,
                                error: Some(error.to_string()),
                            }),
                        },
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                    deadline = host.save_delay().map(|delay| Instant::now() + delay);
                }
                // The page is gone (or the app is exiting): save before the
                // lease drops. Nobody is left to tell, so a failure is logged:
                // the unsaved edits are lost.
                if !closed {
                    if let Err(error) = host.close() {
                        futo_notes_core::log_to_stderr!(
                            "futo-editor-host: closing note {:?} failed, unsaved edits are lost: {error}",
                            host.id()
                        );
                    }
                }
            })
            .map_err(|error| format!("failed to start editor host: {error}"))?;
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
                Err("editor host stopped while opening".to_owned())
            }
        }
    }

    fn sender(&self) -> Result<Sender<Job>, String> {
        self.jobs
            .clone()
            .ok_or_else(|| "editor host closed".to_owned())
    }

    /// Waits for the worker to drop the Store host, releasing the lease.
    fn close(&mut self) {
        self.jobs.take();
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

fn ask<T>(jobs: Sender<Job>, job: impl FnOnce(Sender<T>) -> Job) -> Result<T, String> {
    let (reply, answer) = mpsc::channel();
    jobs.send(job(reply))
        .map_err(|_| "editor host closed".to_owned())?;
    answer.recv().map_err(|_| "editor host closed".to_owned())
}

/// Ids in the order `refresh_note_ids` delivers them natively.
fn note_ids(store: &LocalNoteStore) -> Vec<String> {
    store.recent_note_ids(usize::MAX)
}

#[derive(Default)]
pub(crate) struct EditorHostState {
    attached: Mutex<Option<Worker>>,
    tokens: AtomicU64,
}

impl EditorHostState {
    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Worker>> {
        self.attached
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn open(
        &self,
        store: Arc<LocalNoteStore>,
        id: String,
        saved: impl Fn(EditorSaved) + Send + 'static,
    ) -> Result<EditorOpened, String> {
        // Close first: reopening the same note needs its lease back.
        let previous = self.slot().take();
        drop(previous);
        // Tokens stay below 2^53 so a JavaScript number carries them exactly.
        let token = SessionToken(self.tokens.fetch_add(1, Ordering::Relaxed) + 1);
        let (worker, opened) = Worker::open(store, id, token, saved)?;
        let replaced = self.slot().replace(worker);
        drop(replaced);
        Ok(opened)
    }

    fn jobs(&self, token: u64) -> Result<Sender<Job>, String> {
        match self.slot().as_ref() {
            Some(worker) if worker.token.0 == token => worker.sender(),
            Some(_) => Err("stale editor session".to_owned()),
            None => Err("no note is attached to the editor".to_owned()),
        }
    }

    fn request(&self, token: u64, request: HostRequest) -> Result<HostAck, String> {
        ask(self.jobs(token)?, |reply| Job::Request(request, reply))
    }

    fn checkpoint(&self, token: u64) -> Result<FlushDraftResult, EditorCheckpointError> {
        ask(self.jobs(token)?, Job::Checkpoint)?
    }

    /// Saves unsaved edits, then releases the note. If the save fails the note
    /// stays attached and the error comes back so the page can retry.
    fn close(&self, token: u64) -> Result<FlushDraftResult, EditorCheckpointError> {
        let jobs = self.jobs(token)?;
        let result = ask(jobs, Job::Close)??;
        let worker = self.slot().take();
        drop(worker);
        Ok(result)
    }

    pub(crate) fn close_all(&self) {
        let worker = self.slot().take();
        drop(worker);
    }
}

#[tauri::command]
pub(crate) async fn editor_open(
    app: AppHandle,
    state: State<'_, AppState>,
    note_id: String,
) -> Result<EditorOpened, String> {
    let store = crate::local_notes::store(&app, &state)?;
    let editor = state.editor.clone();
    blocking(move || {
        editor.open(store, note_id, move |saved| {
            let _ = app.emit(SAVED_EVENT, saved);
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn editor_request(
    state: State<'_, AppState>,
    token: u64,
    request: HostRequest,
) -> Result<HostAck, String> {
    let editor = state.editor.clone();
    blocking(move || editor.request(token, request)).await
}

#[tauri::command]
pub(crate) async fn editor_checkpoint(
    state: State<'_, AppState>,
    token: u64,
) -> Result<FlushDraftResult, EditorCheckpointError> {
    let editor = state.editor.clone();
    tauri::async_runtime::spawn_blocking(move || editor.checkpoint(token))
        .await
        .map_err(|error| EditorCheckpointError::from(join_error(error)))?
}

#[tauri::command]
pub(crate) async fn editor_close(
    state: State<'_, AppState>,
    token: u64,
) -> Result<FlushDraftResult, EditorCheckpointError> {
    let editor = state.editor.clone();
    tauri::async_runtime::spawn_blocking(move || editor.close(token))
        .await
        .map_err(|error| EditorCheckpointError::from(join_error(error)))?
}

#[tauri::command]
pub(crate) async fn editor_note_ids(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let store = crate::local_notes::store(&app, &state)?;
    blocking(move || Ok(note_ids(&store))).await
}

#[cfg(test)]
mod tests;
