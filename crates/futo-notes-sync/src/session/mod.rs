use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, Instant, MissedTickBehavior};

pub(crate) mod connect;
mod event_stream;

use crate::checkpoint::{self, ConnectedState};
use crate::sync::{self, ConnectInfo, PreWrite, Progress, SyncErrorKind, SyncSummary};

use event_stream::EventStream;

const SAFETY_POLL: Duration = Duration::from_secs(45);
const READ_IDLE: Duration = Duration::from_secs(90);
const CHANGE_DEBOUNCE: Duration = Duration::from_millis(300);
const PUSH_DEBOUNCE: Duration = Duration::from_secs(1);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

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

struct LiveTask {
    cancel: mpsc::Sender<()>,
    note_changed: mpsc::Sender<()>,
    abort: tokio::task::AbortHandle,
}

#[derive(Default)]
pub struct SyncSession {
    state: Arc<Mutex<Option<ConnectedState>>>,
    cycle_gate: Arc<Mutex<()>>,
    live: std::sync::Mutex<Option<LiveTask>>,
}

impl SyncSession {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn connect(
        &self,
        root: &Path,
        server: &str,
        password: &str,
    ) -> Result<ConnectInfo, SyncErrorKind> {
        self.stop_live();
        let _gate = self.cycle_gate.lock().await;
        let (state, info) = connect::connect(root, server, password).await?;
        *self.state.lock().await = Some(state);
        Ok(info)
    }

    pub async fn resume(
        &self,
        root: &Path,
        credentials: ResumeCredentials,
    ) -> Result<(), SyncErrorKind> {
        self.stop_live();
        let _gate = self.cycle_gate.lock().await;
        let state = connect::resume(
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
        let _gate = self.cycle_gate.lock().await;
        let state = self
            .state
            .lock()
            .await
            .clone()
            .ok_or(SyncErrorKind::NotConnected)?;
        let (summary, state) = sync::cycle(&state, root, progress, pre_write).await?;
        *self.state.lock().await = Some(state);
        Ok(summary)
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
        *self.state.lock().await = None;
        checkpoint::demote(root).map_err(SyncErrorKind::Io)
    }

    pub async fn start_live(
        &self,
        root: PathBuf,
        listener: Arc<dyn SyncSessionListener>,
        pre_write: Arc<PreWrite>,
    ) -> Result<(), SyncErrorKind> {
        if !self.is_connected().await {
            return Err(SyncErrorKind::NotConnected);
        }
        self.stop_live();
        let (cancel_tx, cancel_rx) = mpsc::channel(1);
        let (note_tx, note_rx) = mpsc::channel(1);
        let state = Arc::clone(&self.state);
        let gate = Arc::clone(&self.cycle_gate);
        let mut live = self
            .live
            .lock()
            .map_err(|_| SyncErrorKind::Io("live task lock poisoned".into()))?;
        let join = tokio::spawn(async move {
            live_loop(state, gate, root, listener, pre_write, cancel_rx, note_rx).await;
        });
        *live = Some(LiveTask {
            cancel: cancel_tx,
            note_changed: note_tx,
            abort: join.abort_handle(),
        });
        Ok(())
    }

    pub fn note_changed(&self) {
        if let Ok(live) = self.live.lock() {
            if let Some(task) = live.as_ref() {
                let _ = task.note_changed.try_send(());
            }
        }
    }

    pub fn stop_live(&self) {
        if let Ok(mut live) = self.live.lock() {
            if let Some(task) = live.take() {
                let _ = task.cancel.try_send(());
                task.abort.abort();
            }
        }
    }
}

enum CycleResult {
    Continue,
    Stop,
}

enum StreamResult {
    Reconnect,
    Stop,
}

struct LiveContext<'a> {
    state: &'a Arc<Mutex<Option<ConnectedState>>>,
    gate: &'a Arc<Mutex<()>>,
    root: &'a Path,
    listener: &'a dyn SyncSessionListener,
    pre_write: &'a PreWrite,
}

struct LiveInputs<'a> {
    cancel: &'a mut mpsc::Receiver<()>,
    note_changed: &'a mut mpsc::Receiver<()>,
    safety: &'a mut tokio::time::Interval,
    push_at: &'a mut Option<Instant>,
}

fn classify_cycle_error(error: &SyncErrorKind) -> (CycleResult, String) {
    match error {
        SyncErrorKind::Auth(_) => (CycleResult::Stop, format!("auth: {}", error.message())),
        SyncErrorKind::CollectionGone(_) => (CycleResult::Stop, error.message()),
        _ => (CycleResult::Continue, error.message()),
    }
}

async fn run_cycle(
    state: &Arc<Mutex<Option<ConnectedState>>>,
    gate: &Arc<Mutex<()>>,
    root: &Path,
    listener: &dyn SyncSessionListener,
    pre_write: &PreWrite,
) -> CycleResult {
    let _gate = gate.lock().await;
    let Some(current) = state.lock().await.clone() else {
        return CycleResult::Stop;
    };
    let no_progress = |_: crate::sync::SyncProgress| {};
    match sync::cycle(&current, root, &no_progress, pre_write).await {
        Ok((summary, next)) => {
            *state.lock().await = Some(next);
            listener.on_synced(summary);
            CycleResult::Continue
        }
        Err(error) => {
            let (result, message) = classify_cycle_error(&error);
            listener.on_cycle_error(message);
            result
        }
    }
}

async fn cycle_stopped(context: &LiveContext<'_>) -> bool {
    matches!(
        run_cycle(
            context.state,
            context.gate,
            context.root,
            context.listener,
            context.pre_write,
        )
        .await,
        CycleResult::Stop
    )
}

async fn run_connected_stream(
    response: reqwest::Response,
    context: LiveContext<'_>,
    inputs: LiveInputs<'_>,
) -> StreamResult {
    if cycle_stopped(&context).await {
        return StreamResult::Stop;
    }

    let stream = response.bytes_stream();
    tokio::pin!(stream);
    let mut events = EventStream::default();
    let mut pull_at = None;
    loop {
        let pull_timer = deadline(pull_at);
        let push_timer = deadline(*inputs.push_at);
        tokio::select! {
            _ = inputs.cancel.recv() => return StreamResult::Stop,
            Some(()) = inputs.note_changed.recv() => {
                *inputs.push_at = Some(Instant::now() + PUSH_DEBOUNCE);
            }
            _ = push_timer => {
                *inputs.push_at = None;
                if cycle_stopped(&context).await {
                    return StreamResult::Stop;
                }
            }
            _ = pull_timer => {
                pull_at = None;
                if cycle_stopped(&context).await {
                    return StreamResult::Stop;
                }
            }
            _ = inputs.safety.tick() => {
                if cycle_stopped(&context).await {
                    return StreamResult::Stop;
                }
            }
            chunk = tokio::time::timeout(READ_IDLE, stream.next()) => {
                match chunk {
                    Ok(Some(Ok(bytes))) => {
                        for event in events.push(&bytes) {
                            if event == "ready" || event == "change" {
                                pull_at = Some(Instant::now() + CHANGE_DEBOUNCE);
                            }
                        }
                    }
                    Ok(Some(Err(error))) => {
                        context.listener.on_error(format!("read: {error}"));
                        return StreamResult::Reconnect;
                    }
                    Ok(None) => {
                        context.listener.on_error("read: event stream closed".into());
                        return StreamResult::Reconnect;
                    }
                    Err(_) => {
                        context.listener.on_error("read: event stream idle timeout".into());
                        return StreamResult::Reconnect;
                    }
                }
            }
        }
    }
}

async fn wait_for_reconnect(backoff: &mut Duration, cancel: &mut mpsc::Receiver<()>) -> bool {
    if wait_or_cancel(*backoff, cancel).await {
        return true;
    }
    *backoff = (*backoff * 2).min(BACKOFF_MAX);
    false
}

async fn live_loop(
    state: Arc<Mutex<Option<ConnectedState>>>,
    gate: Arc<Mutex<()>>,
    root: PathBuf,
    listener: Arc<dyn SyncSessionListener>,
    pre_write: Arc<PreWrite>,
    mut cancel: mpsc::Receiver<()>,
    mut note_changed: mpsc::Receiver<()>,
) {
    let mut safety = interval(SAFETY_POLL);
    safety.set_missed_tick_behavior(MissedTickBehavior::Delay);
    safety.tick().await;
    let mut backoff = BACKOFF_MIN;
    let mut push_at = None;

    loop {
        let Some(snapshot) = state.lock().await.clone() else {
            break;
        };
        let http = match connect::client(&snapshot) {
            Ok(http) => http,
            Err(error) => {
                listener.on_error(error.message());
                if wait_for_reconnect(&mut backoff, &mut cancel).await {
                    break;
                }
                continue;
            }
        };
        let response = tokio::select! {
            _ = cancel.recv() => break,
            response = http.events() => response,
        };
        let response = match response {
            Ok(response) => response,
            Err(error) if error.is(401) => {
                listener.on_error(format!("auth: {error}"));
                break;
            }
            Err(error) => {
                listener.on_error(format!("connect: {error}"));
                if wait_for_reconnect(&mut backoff, &mut cancel).await {
                    break;
                }
                continue;
            }
        };
        backoff = BACKOFF_MIN;
        listener.on_connected();
        if matches!(
            run_connected_stream(
                response,
                LiveContext {
                    state: &state,
                    gate: &gate,
                    root: &root,
                    listener: listener.as_ref(),
                    pre_write: pre_write.as_ref(),
                },
                LiveInputs {
                    cancel: &mut cancel,
                    note_changed: &mut note_changed,
                    safety: &mut safety,
                    push_at: &mut push_at,
                },
            )
            .await,
            StreamResult::Stop
        ) {
            break;
        }
        if wait_for_reconnect(&mut backoff, &mut cancel).await {
            break;
        }
    }
    listener.on_stopped();
}

async fn deadline(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

async fn wait_or_cancel(duration: Duration, cancel: &mut mpsc::Receiver<()>) -> bool {
    tokio::select! {
        _ = cancel.recv() => true,
        _ = tokio::time::sleep(duration) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn connected() -> ConnectedState {
        ConnectedState {
            base_url: "http://127.0.0.1:1".into(),
            token: "token".into(),
            user_id: "user".into(),
            collection_id: "collection".into(),
            vault_key: [3; 32],
            object_map: HashMap::new(),
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

    #[test]
    fn stop_and_change_notifications_are_safe_without_a_live_task() {
        let session = SyncSession::new();
        session.note_changed();
        session.stop_live();
        session.stop_live();
    }

    #[test]
    fn auth_cycle_errors_stop_and_emit_reauthentication_signal() {
        let (result, message) = classify_cycle_error(&SyncErrorKind::Auth(
            "HTTP 401: session expired or invalid".into(),
        ));

        assert!(matches!(result, CycleResult::Stop));
        assert_eq!(message, "auth: HTTP 401: session expired or invalid");
    }

    #[test]
    fn collection_gone_stops_but_transient_http_errors_continue() {
        let (gone_result, gone_message) = classify_cycle_error(&SyncErrorKind::CollectionGone(
            "HTTP 404: collection not found".into(),
        ));
        assert!(matches!(gone_result, CycleResult::Stop));
        assert_eq!(
            gone_message,
            "collection-gone: HTTP 404: collection not found"
        );

        let (http_result, http_message) =
            classify_cycle_error(&SyncErrorKind::Http("HTTP 500: unavailable".into()));
        assert!(matches!(http_result, CycleResult::Continue));
        assert_eq!(http_message, "HTTP 500: unavailable");
    }
}
