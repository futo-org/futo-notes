//! Desktop host for the text-first editor's portable (WASM) page (#283).
//!
//! The page owns a `WasmSession` and emits one ordered `HostRequest` at a time;
//! this module routes each to a dedicated worker thread that owns the note's
//! `StoreEditorHost` and answers with the Store's `HostAck`. One note is
//! attached at a time; switching opens the next one before it releases it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};

use futo_notes_editor::{HostAck, HostRequest, HostSnapshot, Revision, SessionToken};
use futo_notes_store::{EditorStoreError, LocalNoteStore, MutationResult};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::application_state::AppState;
use crate::background_tasks::{blocking, join_error};

mod worker;
use worker::{Emit, Job, SaveHold, Worker};

/// Emitted by the worker when its save timer fires (and writes, or fails to)
/// and when a store workflow moved the attached note (a move, a sync
/// relocation). Payload: [`EditorSaved`].
pub(crate) const SAVED_EVENT: &str = "editor:saved";

/// What the worker did to the attached note: a save of its timer, a checkpoint,
/// rename, reload or release, or a move a store workflow made. Each reaches the
/// page once, on the event or as its command's reply, which Tauri does not
/// order between them; `stamp` does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorOutcome {
    /// Increasing per attachment in the worker's order. The page follows a
    /// change of `note_id` only from an outcome newer than the last it applied.
    pub(crate) stamp: u64,
    /// The note the attachment holds after it.
    pub(crate) note_id: String,
    /// The draft's revision then; when `saved`, the note holds the draft at it.
    pub(crate) revision: Revision,
    /// The draft is on disk (written, converged, recreated or parked). False for
    /// a move, a release that discarded, and a save the test hold declined.
    pub(crate) saved: bool,
    /// The save parked the draft in `note_id`, a conflict copy; the note it
    /// left keeps its bytes.
    pub(crate) parked: bool,
    /// Apply before anything reads the notes again.
    pub(crate) mutation: Option<MutationResult>,
    /// The note holds this source, not the draft at `revision` (an outside
    /// change merged in, or a clean draft's outside source); the page adopts
    /// it at `revision`.
    pub(crate) offered: Option<String>,
    /// The save recreated the note after an outside delete; the draft was kept.
    pub(crate) recreated: bool,
    /// The timer's write failed; the Store retries, so the page keeps typing.
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorSaved {
    pub(crate) token: u64,
    pub(crate) outcome: EditorOutcome,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorOpened {
    pub(crate) token: u64,
    pub(crate) note_id: String,
    /// Feed to `WasmSession.restore`.
    pub(crate) snapshot: HostSnapshot,
}

/// The note now attached, and how the one it replaced was released.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorSwitched {
    pub(crate) opened: EditorOpened,
    pub(crate) closed: Option<EditorOutcome>,
}

/// Why a command that saves did not complete. Nothing changed: the note that
/// was attached still is, accepting input; the page may retry.
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
    hold: SaveHold,
}

impl EditorHostState {
    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Worker>> {
        self.attached
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn next_token(&self) -> SessionToken {
        // Tokens stay below 2^53 so a JavaScript number carries them exactly.
        SessionToken(self.tokens.fetch_add(1, Ordering::Relaxed) + 1)
    }

    /// Attaches `id`, then releases the note attached before it (saving it, or
    /// with `discard` dropping its draft). A failure at either step leaves the
    /// previous note attached and nothing changed. The note already attached
    /// (exactly `id`) is saved, or dropped, and read back from disk instead; any
    /// other note whose lease is held fails the switch.
    fn switch(
        &self,
        store: Arc<LocalNoteStore>,
        id: String,
        discard: bool,
        emit: Emit,
    ) -> Result<EditorSwitched, EditorCheckpointError> {
        let (incoming, opened) = match Worker::open(
            store,
            id.clone(),
            self.next_token(),
            self.hold.clone(),
            emit,
        ) {
            Ok(opened) => opened,
            Err(EditorStoreError::SessionAlreadyOpen) => {
                let jobs = match self.slot().as_ref() {
                    Some(worker) => worker.sender()?,
                    None => return Err(EditorStoreError::SessionAlreadyOpen.into()),
                };
                return self.reload(jobs, Some(id), discard);
            }
            Err(error) => return Err(error.into()),
        };
        // On failure `incoming` drops here, releasing the note it just opened.
        let closed = self.release(discard)?;
        let replaced = self.slot().replace(incoming);
        drop(replaced);
        Ok(EditorSwitched { opened, closed })
    }

    /// Saves (or drops) the attached note's draft and releases it; nothing
    /// attached is `None`. A failed save leaves it attached.
    fn release(&self, discard: bool) -> Result<Option<EditorOutcome>, EditorCheckpointError> {
        let jobs = match self.slot().as_ref() {
            Some(worker) => worker.sender()?,
            None => return Ok(None),
        };
        let outcome = ask(jobs, |reply| Job::Close { discard, reply })??;
        let worker = self.slot().take();
        drop(worker);
        Ok(Some(outcome))
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

    fn checkpoint(&self, token: u64) -> Result<EditorOutcome, EditorCheckpointError> {
        ask(self.jobs(token)?, Job::Checkpoint)?
    }

    /// The title's rename, in the folder the note is in when it runs.
    fn rename(&self, token: u64, title: String) -> Result<EditorOutcome, EditorCheckpointError> {
        ask(self.jobs(token)?, |reply| Job::Rename(title, reply))?
    }

    /// Saves (or drops) the draft the worker holds, then reads its note back from
    /// disk into a fresh draft under a new token, keeping its lease: `closed` is
    /// the save. With `only`, nothing happens unless that is the note attached.
    fn reload(
        &self,
        jobs: Sender<Job>,
        only: Option<String>,
        discard: bool,
    ) -> Result<EditorSwitched, EditorCheckpointError> {
        let fresh = self.next_token();
        let (closed, opened) = ask(jobs, |reply| Job::Reload {
            token: fresh,
            only,
            discard,
            reply,
        })??;
        if let Some(worker) = self.slot().as_mut() {
            worker.token = fresh;
        }
        Ok(EditorSwitched {
            opened,
            closed: Some(closed),
        })
    }

    /// Reads the note `token` holds back from disk (see `reload`).
    fn reload_token(&self, token: u64) -> Result<EditorSwitched, EditorCheckpointError> {
        self.reload(self.jobs(token)?, None, false)
    }

    fn close(&self, token: u64, discard: bool) -> Result<EditorOutcome, EditorCheckpointError> {
        self.jobs(token)?;
        self.release(discard)?
            .ok_or_else(|| "no note is attached to the editor".to_owned().into())
    }

    /// A release writes nothing by itself: the worker's next job (a flush) does.
    fn hold_saves(&self, held: bool) -> Result<(), String> {
        self.hold.set(held)
    }

    pub(crate) fn close_all(&self) {
        let worker = self.slot().take();
        drop(worker);
    }
}

fn emitter(app: AppHandle) -> Emit {
    Arc::new(move |saved| {
        let _ = app.emit(SAVED_EVENT, saved);
    })
}

async fn on_worker<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, EditorCheckpointError> + Send + 'static,
) -> Result<T, EditorCheckpointError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| EditorCheckpointError::from(join_error(error)))?
}

/// Attaches `note_id` (nothing attached yet, or another note: see `switch`).
#[tauri::command]
pub(crate) async fn editor_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    note_id: String,
    discard: bool,
) -> Result<EditorSwitched, EditorCheckpointError> {
    let store = crate::local_notes::store(&app, &state)?;
    let editor = state.editor.clone();
    on_worker(move || editor.switch(store, note_id, discard, emitter(app))).await
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
) -> Result<EditorOutcome, EditorCheckpointError> {
    let editor = state.editor.clone();
    on_worker(move || editor.checkpoint(token)).await
}

/// Saves the draft as `title` in the note's own folder in one Store workflow
/// (write and rename, or park when the note changed underneath); the
/// attachment follows it.
#[tauri::command]
pub(crate) async fn editor_rename(
    state: State<'_, AppState>,
    token: u64,
    title: String,
) -> Result<EditorOutcome, EditorCheckpointError> {
    let editor = state.editor.clone();
    on_worker(move || editor.rename(token, title)).await
}

/// Saves the note `token` holds, then reads it back from disk into a fresh
/// draft under a new token (an outside change adopted).
#[tauri::command]
pub(crate) async fn editor_reload(
    state: State<'_, AppState>,
    token: u64,
) -> Result<EditorSwitched, EditorCheckpointError> {
    let editor = state.editor.clone();
    on_worker(move || editor.reload_token(token)).await
}

#[tauri::command]
pub(crate) async fn editor_close(
    state: State<'_, AppState>,
    token: u64,
    discard: bool,
) -> Result<EditorOutcome, EditorCheckpointError> {
    let editor = state.editor.clone();
    on_worker(move || editor.close(token, discard)).await
}

#[tauri::command]
pub(crate) async fn editor_note_ids(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let store = crate::local_notes::store(&app, &state)?;
    blocking(move || Ok(note_ids(&store))).await
}

/// Test automation only: while held, the attached note's saves decline without
/// writing. A shipped (release) build refuses.
#[tauri::command]
pub(crate) fn editor_hold_saves(state: State<'_, AppState>, held: bool) -> Result<(), String> {
    state.editor.hold_saves(held)
}

#[cfg(test)]
mod tests;
