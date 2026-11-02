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

use futo_notes_editor::{HostAck, HostOperation, HostRequest, HostSnapshot, SessionToken};
use futo_notes_store::{FlushDraftResult, LocalNoteStore, RecoveryIssue, RecoveryIssueKind};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::application_state::AppState;
use crate::background_tasks::blocking;

/// Payload: the session token whose recovery flush deadline has passed. The
/// page answers with its own `flush()` request; this event acknowledges nothing.
pub(crate) const FLUSH_DUE_EVENT: &str = "editor:flush-due";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorOpened {
    pub(crate) token: u64,
    /// Feed to `WasmSession.restore`; a recovered pause is preserved.
    pub(crate) snapshot: HostSnapshot,
    pub(crate) recovery_issue: Option<EditorRecoveryIssue>,
    /// For the page's first `update_note_ids`.
    pub(crate) note_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditorRecoveryIssue {
    pub(crate) kind: &'static str,
    /// Zero for the header, one-based for edit records.
    pub(crate) record: usize,
    pub(crate) version: Option<u32>,
}

impl From<RecoveryIssue> for EditorRecoveryIssue {
    fn from(issue: RecoveryIssue) -> Self {
        let (kind, version) = match issue.kind {
            RecoveryIssueKind::TornTail => ("TornTail", None),
            RecoveryIssueKind::CorruptRecord => ("CorruptRecord", None),
            RecoveryIssueKind::InvalidEdit => ("InvalidEdit", None),
            RecoveryIssueKind::SequenceMismatch => ("SequenceMismatch", None),
            RecoveryIssueKind::IdentityMismatch => ("IdentityMismatch", None),
            RecoveryIssueKind::UnsupportedVersion { version } => {
                ("UnsupportedVersion", Some(version))
            }
            RecoveryIssueKind::BaseMismatch => ("BaseMismatch", None),
        };
        Self {
            kind,
            record: issue.record,
            version,
        }
    }
}

enum Job {
    Request(HostRequest, Sender<HostAck>),
    Checkpoint(Sender<Result<FlushDraftResult, String>>),
}

/// One attached note: its worker thread exclusively owns the Store host, so
/// every blocking Store call and the flush timer run off the IPC threads.
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
        flush_due: impl Fn(SessionToken) + Send + 'static,
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
                    recovery_issue: host.recovery_issue().map(Into::into),
                    note_ids: note_ids(&store),
                }));
                let mut last_sequence = 0;
                let mut deadline: Option<Instant> = None;
                loop {
                    let job = match deadline {
                        Some(at) => {
                            inbox.recv_timeout(at.saturating_duration_since(Instant::now()))
                        }
                        None => inbox.recv().map_err(|_| RecvTimeoutError::Disconnected),
                    };
                    match job {
                        Ok(Job::Request(request, reply)) => {
                            if request.token == token {
                                last_sequence = last_sequence.max(request.sequence);
                            }
                            let _ = reply.send(host.handle(request));
                        }
                        Ok(Job::Checkpoint(reply)) => {
                            let _ =
                                reply.send(host.checkpoint().map_err(|error| error.to_string()));
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            // Once per armed deadline; the next request re-arms it.
                            flush_due(token);
                            deadline = None;
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                    deadline = host
                        .recovery_flush_delay()
                        .map(|delay| Instant::now() + delay);
                }
                // Closing: make accepted edits durable before the lease drops.
                // The page is gone, so a sequence past its last request is free.
                if host.recovery_flush_delay().is_some() {
                    host.handle(HostRequest {
                        token,
                        sequence: last_sequence.saturating_add(1),
                        operation: HostOperation::Flush,
                    });
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
        flush_due: impl Fn(SessionToken) + Send + 'static,
    ) -> Result<EditorOpened, String> {
        // Close first: reopening the same note needs its lease back.
        let previous = self.slot().take();
        drop(previous);
        // Tokens stay below 2^53 so a JavaScript number carries them exactly.
        let token = SessionToken(self.tokens.fetch_add(1, Ordering::Relaxed) + 1);
        let (worker, opened) = Worker::open(store, id, token, flush_due)?;
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

    fn checkpoint(&self, token: u64) -> Result<FlushDraftResult, String> {
        ask(self.jobs(token)?, Job::Checkpoint)?
    }

    fn close(&self, token: u64) -> Result<(), String> {
        let mut slot = self.slot();
        if slot.as_ref().is_some_and(|worker| worker.token.0 != token) {
            return Err("stale editor session".to_owned());
        }
        let worker = slot.take();
        drop(slot);
        drop(worker);
        Ok(())
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
        editor.open(store, note_id, move |token| {
            let _ = app.emit(FLUSH_DUE_EVENT, token.0);
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
) -> Result<FlushDraftResult, String> {
    let editor = state.editor.clone();
    blocking(move || editor.checkpoint(token)).await
}

#[tauri::command]
pub(crate) async fn editor_close(state: State<'_, AppState>, token: u64) -> Result<(), String> {
    let editor = state.editor.clone();
    blocking(move || editor.close(token)).await
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
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;
    use std::time::Duration;

    use futo_notes_editor::{DisplayOffset, DisplayRange, PortableSession, Revision};

    use super::*;

    fn at(offset: usize) -> DisplayRange {
        DisplayRange {
            start: DisplayOffset(offset),
            end: DisplayOffset(offset),
        }
    }

    fn vault(source: &str) -> (PathBuf, Arc<LocalNoteStore>) {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let root = std::env::temp_dir().join(format!(
            "futo-notes-tauri-editor-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(LocalNoteStore::new(root.clone()));
        store.create("", "plain", source).unwrap();
        (root, store)
    }

    fn open(
        hosts: &EditorHostState,
        store: &Arc<LocalNoteStore>,
    ) -> (EditorOpened, PortableSession) {
        let opened = hosts.open(store.clone(), "plain".into(), |_| {}).unwrap();
        let page = PortableSession::from_snapshot(opened.snapshot.clone()).unwrap();
        (opened, page)
    }

    /// The page's ordered exchange: request, host ack, release.
    fn exchange(
        hosts: &EditorHostState,
        token: u64,
        page: &mut PortableSession,
        request: HostRequest,
    ) -> HostAck {
        let ack = hosts.request(token, request).unwrap();
        page.acknowledge(ack.clone()).unwrap();
        ack
    }

    #[test]
    fn accepted_edits_flush_checkpoint_and_replay_after_reopening() {
        let (root, store) = vault("ab");
        let hosts = EditorHostState::default();
        let (opened, mut page) = open(&hosts, &store);
        assert_eq!(opened.snapshot.source, "ab");
        assert_eq!(opened.note_ids, ["plain"]);
        let edit = page.replace(Revision(0), at(2), "c").unwrap();
        let ack = exchange(&hosts, opened.token, &mut page, edit);
        assert_eq!(
            (ack.accepted, ack.durable, ack.error),
            (Revision(1), Revision(0), None)
        );
        let flush = page.flush().unwrap();
        assert_eq!(
            exchange(&hosts, opened.token, &mut page, flush).durable,
            Revision(1)
        );

        // Closing without a checkpoint keeps the draft recoverable, not saved.
        hosts.close(opened.token).unwrap();
        assert_eq!(store.read_existing("plain").unwrap().as_deref(), Some("ab"));
        let (reopened, _) = open(&hosts, &store);
        assert_eq!(reopened.snapshot.source, "abc");
        assert_ne!(reopened.token, opened.token);
        hosts.checkpoint(reopened.token).unwrap();
        assert_eq!(
            store.read_existing("plain").unwrap().as_deref(),
            Some("abc")
        );
        hosts.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_tokens_are_refused_and_close_releases_the_lease() {
        let (root, store) = vault("ab");
        let hosts = EditorHostState::default();
        let (first, mut page) = open(&hosts, &store);
        // A second store handle cannot attach while the host holds the lease.
        assert!(store.open_editor("plain").is_err());
        let (second, _) = open(&hosts, &store);
        let edit = page.replace(Revision(0), at(0), "x").unwrap();
        assert_eq!(
            hosts.request(first.token, edit.clone()),
            Err("stale editor session".into())
        );
        assert_eq!(
            hosts.checkpoint(first.token).unwrap_err(),
            "stale editor session"
        );
        assert!(hosts.close(first.token).is_err());
        // A request carrying the old token through the live route is refused by Store.
        let ack = hosts.request(second.token, edit.clone()).unwrap();
        assert_eq!(ack.accepted, Revision(0));
        assert!(ack.error.is_some());

        hosts.close(second.token).unwrap();
        assert_eq!(
            hosts.request(second.token, edit),
            Err("no note is attached to the editor".into())
        );
        drop(store.open_editor("plain").unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_save_is_refused_while_attached() {
        let (root, store) = vault("ab");
        let hosts = EditorHostState::default();
        let (opened, mut page) = open(&hosts, &store);
        let edit = page.replace(Revision(0), at(2), "c").unwrap();
        exchange(&hosts, opened.token, &mut page, edit);
        // The Store refuses by lease, under its gate, whatever the key's case.
        let refusal = store.save_unattached(None, "PLAIN", "x", None).unwrap_err();
        assert!(refusal.contains("editor_checkpoint"), "{refusal}");
        store
            .flush_draft_unattached("Plain", "ab", "abc")
            .unwrap_err();
        store.save_unattached(None, "Other", "x", None).unwrap();
        hosts.close_all();
        store
            .save_unattached(Some("plain"), "plain", "x", None)
            .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worker_signals_a_due_flush_that_the_page_performs() {
        let (root, store) = vault("ab");
        let hosts = EditorHostState::default();
        let (due_tx, due) = mpsc::channel();
        let opened = hosts
            .open(store.clone(), "plain".into(), move |token| {
                let _ = due_tx.send(token);
            })
            .unwrap();
        let mut page = PortableSession::from_snapshot(opened.snapshot.clone()).unwrap();
        let edit = page.replace(Revision(0), at(2), "c").unwrap();
        exchange(&hosts, opened.token, &mut page, edit);
        // The timer only tells the page; durability still needs its Flush.
        let token = due.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(token.0, opened.token);
        assert!(due.recv_timeout(Duration::from_millis(300)).is_err());
        assert_eq!(page.status().durable, Revision(0));
        let flush = page.flush().unwrap();
        assert_eq!(
            exchange(&hosts, opened.token, &mut page, flush).durable,
            Revision(1)
        );

        let edit = page.replace(Revision(1), at(3), "d").unwrap();
        exchange(&hosts, opened.token, &mut page, edit);
        hosts.close(opened.token).unwrap();
        let (reopened, _) = open(&hosts, &store);
        assert_eq!(reopened.snapshot.source, "abcd");
        hosts.close_all();
        std::fs::remove_dir_all(root).unwrap();
    }
}
