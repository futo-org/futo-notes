use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

pub(crate) mod connect;
mod cycle;
mod live;

use futo_notes_core::journal::Journal;

use crate::checkpoint::{self, ConnectedState};
use crate::journal::{SyncRunJournal, SyncTrigger};
use crate::server::{HttpClients, HttpError};
use crate::sync::{ConnectInfo, PreWrite, Progress, SyncErrorKind, SyncSummary};

use live::LiveTask;

pub trait SyncSessionListener: Send + Sync {
    fn on_synced(&self, summary: SyncSummary);
    fn on_connected(&self);
    fn on_error(&self, message: String);
    fn on_cycle_error(&self, message: String) {
        self.on_error(message);
    }
    fn on_stopped(&self);
}

pub struct ResumeCredentials {
    pub server_url: String,
    pub token: String,
    pub user_id: String,
    pub collection_id: String,
    pub password: String,
}

/// What a hosted setup hands over once its vault is unlocked. The vault key is
/// here in place of a password, which is the whole difference between the two
/// unlock models: password mode derives the key at every connect, hosted mode
/// holds it (ADR 0003, decision 4).
pub struct HostedCredentials {
    pub server_url: String,
    pub token: String,
    pub user_id: String,
    pub collection_id: String,
    pub vault_key: [u8; 32],
}

/// The running live task, if any, and how many stops this session has seen.
/// A start installs its task only if no stop arrived after it was asked for.
#[derive(Default)]
struct LiveSlot {
    task: Option<LiveTask>,
    stops: u64,
}

pub struct SyncSession {
    state: Arc<Mutex<Option<ConnectedState>>>,
    cycle_gate: Arc<Mutex<()>>,
    live: Arc<std::sync::Mutex<LiveSlot>>,
    journal: std::sync::Mutex<Journal>,
    clients: Result<HttpClients, HttpError>,
}

impl Default for SyncSession {
    fn default() -> Self {
        Self {
            state: Arc::default(),
            cycle_gate: Arc::default(),
            live: Arc::default(),
            journal: std::sync::Mutex::default(),
            clients: HttpClients::new(),
        }
    }
}

impl SyncSession {
    pub fn new() -> Self {
        Self::default()
    }

    fn clients(&self) -> Result<&HttpClients, SyncErrorKind> {
        self.clients
            .as_ref()
            .map_err(|error| connect::http_error(error.clone()))
    }

    /// Points this session's runs at an instance journal. Sessions start with a
    /// disabled one, so a shell that has not resolved a data directory — every
    /// native shell today — journals nothing and behaves exactly as before.
    pub fn set_journal(&self, journal: Journal) {
        if let Ok(mut current) = self.journal.lock() {
            *current = journal;
        }
    }

    fn journal_handle(&self) -> Journal {
        self.journal
            .lock()
            .map(|journal| journal.clone())
            .unwrap_or_default()
    }

    pub async fn connect(
        &self,
        root: &Path,
        server: &str,
        password: &str,
    ) -> Result<ConnectInfo, SyncErrorKind> {
        self.stop_live();
        let _gate = self.cycle_gate.lock().await;
        let (state, info) = connect::connect(self.clients()?, root, server, password).await?;
        *self.state.lock().await = Some(state);
        Ok(info)
    }

    /// Connects with secrets a hosted setup already holds, rather than with a
    /// password. This is what makes the end of the hosted wizard a session that
    /// can run a cycle; [`crate::HostedSetup::connect_sync`] is the only caller,
    /// because it is the thing that knows the key and the token are real.
    pub async fn connect_hosted(
        &self,
        root: &Path,
        credentials: HostedCredentials,
    ) -> Result<(), SyncErrorKind> {
        self.stop_live();
        let _gate = self.cycle_gate.lock().await;
        let state = connect::hosted(
            root,
            &credentials.server_url,
            credentials.token,
            credentials.user_id,
            credentials.collection_id,
            credentials.vault_key,
        )?;
        *self.state.lock().await = Some(state);
        Ok(())
    }

    pub async fn resume(
        &self,
        root: &Path,
        credentials: ResumeCredentials,
    ) -> Result<(), SyncErrorKind> {
        self.stop_live();
        let _gate = self.cycle_gate.lock().await;
        let state = connect::resume(
            self.clients()?,
            root,
            &credentials.server_url,
            &credentials.token,
            &credentials.user_id,
            &credentials.collection_id,
            &credentials.password,
        )
        .await?;
        *self.state.lock().await = Some(state);
        Ok(())
    }

    pub async fn sync(
        &self,
        root: &Path,
        progress: &Progress,
        pre_write: &PreWrite,
    ) -> Result<SyncSummary, SyncErrorKind> {
        cycle::run(
            &self.state,
            &self.cycle_gate,
            root,
            progress,
            pre_write,
            &SyncRunJournal::new(self.journal_handle(), SyncTrigger::Manual),
            self.clients()?,
        )
        .await
    }

    pub async fn snapshot(&self) -> Option<ConnectedState> {
        self.state.lock().await.clone()
    }

    pub fn status(&self) -> Option<ConnectedState> {
        self.state.try_lock().ok().and_then(|state| state.clone())
    }

    pub async fn is_connected(&self) -> bool {
        self.state.lock().await.is_some()
    }

    pub async fn disconnect(&self, root: &Path) -> Result<(), SyncErrorKind> {
        self.stop_live();
        let _gate = self.cycle_gate.lock().await;
        // A disconnected device must not leave its bearer token usable on the
        // server. Network failure cannot keep the local vault connected, so
        // revocation is best-effort and bounded by the HTTP client's timeout.
        let connected = self.state.lock().await.clone();
        if let Some(state) = connected {
            if let Ok(http) = self.clients().and_then(|clients| {
                clients
                    .for_base(&state.base_url)
                    .map_err(connect::http_error)
            }) {
                let _ = http.token(&state.token).logout().await;
            }
        }
        *self.state.lock().await = None;
        checkpoint::demote(root).map_err(SyncErrorKind::Io)
    }

    /// Starts the live task. The request is taken when this is called, not
    /// when the returned future runs: a `stop_live` or `stop_live_and_wait`
    /// called in between voids it, and it then resolves `Ok` without starting
    /// anything. A shell that hands the future to another task (the FFI runs
    /// it on the runtime) can therefore stop live sync at any point after
    /// asking for it, and the stop wins (#278).
    pub fn start_live(
        &self,
        root: PathBuf,
        listener: Arc<dyn SyncSessionListener>,
        pre_write: Arc<PreWrite>,
    ) -> impl Future<Output = Result<(), SyncErrorKind>> + Send + 'static {
        let asked_after = self.live.lock().map(|live| live.stops).ok();
        let live = Arc::clone(&self.live);
        let state = Arc::clone(&self.state);
        let cycle_gate = Arc::clone(&self.cycle_gate);
        let journal = self.journal_handle();
        let clients = self.clients().cloned();
        async move {
            if state.lock().await.is_none() {
                return Err(SyncErrorKind::NotConnected);
            }
            let clients = clients?;
            let mut live = live.lock().map_err(|_| live_lock_poisoned())?;
            if Some(live.stops) != asked_after {
                return Ok(());
            }
            if let Some(task) = live.task.take() {
                task.abort();
            }
            live.task = Some(live::spawn_live_task(
                state, cycle_gate, root, listener, pre_write, journal, clients,
            ));
            Ok(())
        }
    }

    pub fn note_changed(&self) {
        if let Ok(live) = self.live.lock() {
            if let Some(task) = live.task.as_ref() {
                task.notify_note_changed();
            }
        }
    }

    pub fn stop_live(&self) {
        if let Some(task) = self.end_live() {
            task.abort();
        }
    }

    /// Stop the live task and wait until any cycle already holding the vault is done.
    /// Like `stop_live`, the stop takes effect when this is called.
    pub fn stop_live_and_wait(&self) -> impl Future<Output = ()> + Send + 'static {
        let live_task = self.end_live();
        let cycle_gate = Arc::clone(&self.cycle_gate);
        async move {
            if let Some(task) = live_task {
                task.stop_and_wait().await;
            }
            let _gate = cycle_gate.lock().await;
        }
    }

    /// Takes the live task and voids every start asked for before now.
    fn end_live(&self) -> Option<LiveTask> {
        let mut live = self.live.lock().ok()?;
        live.stops = live.stops.wrapping_add(1);
        live.task.take()
    }
}

fn live_lock_poisoned() -> SyncErrorKind {
    SyncErrorKind::Io("live task lock poisoned".into())
}

#[cfg(test)]
mod disconnect_tests {
    use super::*;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn disconnect_revokes_the_bearer_session_before_forgetting_it() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/logout"))
            .and(header("authorization", "Bearer session-token"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let root = std::env::temp_dir().join(format!("sync-disconnect-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir(&root).unwrap();
        let sync = SyncSession::new();
        *sync.state.lock().await = Some(ConnectedState::new(
            server.uri(),
            "session-token".into(),
            "user".into(),
            "collection".into(),
            [0; 32],
        ));

        sync.disconnect(&root).await.unwrap();

        assert!(!sync.is_connected().await);
        server.verify().await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn failed_logout_still_disconnects_locally() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/logout"))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&server)
            .await;
        let root = std::env::temp_dir().join(format!("sync-disconnect-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir(&root).unwrap();
        let sync = SyncSession::new();
        *sync.state.lock().await = Some(ConnectedState::new(
            server.uri(),
            "session-token".into(),
            "user".into(),
            "collection".into(),
            [0; 32],
        ));

        sync.disconnect(&root).await.unwrap();

        assert!(!sync.is_connected().await);
        server.verify().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn connected() -> ConnectedState {
        ConnectedState {
            base_url: "http://127.0.0.1:1".into(),
            token: "token".into(),
            user_id: "user".into(),
            collection_id: "collection".into(),
            vault_key: [3; 32],
            object_map: HashMap::new(),
            pending_creates: HashMap::new(),
            max_version: 0,
            pull_cursor: 0,
            oversize_skip: HashMap::new(),
        }
    }

    #[tokio::test]
    async fn status_is_nonblocking_and_reports_lock_contention_as_unavailable() {
        let session = SyncSession::new();
        *session.state.lock().await = Some(connected());
        assert_eq!(session.status().unwrap().collection_id, "collection");

        let _held = session.state.lock().await;
        assert!(session.status().is_none());
    }

    struct SilentListener;

    impl SyncSessionListener for SilentListener {
        fn on_synced(&self, _summary: SyncSummary) {}
        fn on_connected(&self) {}
        fn on_error(&self, _message: String) {}
        fn on_stopped(&self) {}
    }

    fn start_args() -> (PathBuf, Arc<dyn SyncSessionListener>, Arc<PreWrite>) {
        (
            std::env::temp_dir().join("sync-live-never-written"),
            Arc::new(SilentListener),
            Arc::new(|_: &str| {}),
        )
    }

    fn is_live(session: &SyncSession) -> bool {
        session.live.lock().unwrap().task.is_some()
    }

    /// #278: a shell that backgrounds the app between asking for live sync and
    /// that request being carried out must not get live sync anyway.
    #[tokio::test]
    async fn stop_live_voids_a_start_live_that_has_not_run_yet() {
        let session = SyncSession::new();
        *session.state.lock().await = Some(connected());
        let (root, listener, pre_write) = start_args();

        let start = session.start_live(root, listener, pre_write);
        session.stop_live();
        start.await.unwrap();

        assert!(!is_live(&session));
    }

    #[tokio::test]
    async fn stop_live_and_wait_voids_a_start_live_that_has_not_run_yet() {
        let session = SyncSession::new();
        *session.state.lock().await = Some(connected());
        let (root, listener, pre_write) = start_args();

        let start = session.start_live(root, listener, pre_write);
        session.stop_live_and_wait().await;
        start.await.unwrap();

        assert!(!is_live(&session));
    }

    /// The same race inside the body: the connected check awaits the state
    /// lock, and a stop can land while it is parked there.
    #[tokio::test]
    async fn stop_live_voids_a_start_live_parked_on_the_connected_check() {
        let session = Arc::new(SyncSession::new());
        *session.state.lock().await = Some(connected());
        let held = session.state.lock().await;
        let start = {
            let session = Arc::clone(&session);
            tokio::spawn(async move {
                let (root, listener, pre_write) = start_args();
                session.start_live(root, listener, pre_write).await
            })
        };

        tokio::task::yield_now().await;
        assert!(!start.is_finished());
        session.stop_live();
        drop(held);
        start.await.unwrap().unwrap();

        assert!(!is_live(&session));
    }

    /// A stop only voids starts asked for before it: a later start still runs.
    #[tokio::test]
    async fn start_live_after_stop_live_still_starts() {
        let session = SyncSession::new();
        *session.state.lock().await = Some(connected());
        session.stop_live();
        let (root, listener, pre_write) = start_args();

        session.start_live(root, listener, pre_write).await.unwrap();

        assert!(is_live(&session));
        session.stop_live();
    }

    #[tokio::test]
    async fn stop_live_and_wait_observes_the_cycle_gate() {
        let session = Arc::new(SyncSession::new());
        let held = session.cycle_gate.lock().await;
        let waiting = {
            let session = Arc::clone(&session);
            tokio::spawn(async move { session.stop_live_and_wait().await })
        };

        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(held);
        waiting.await.unwrap();
    }
}
