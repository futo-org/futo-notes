use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

pub(crate) mod connect;
mod cycle;
mod live;

use crate::checkpoint::{self, ConnectedState};
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
        cycle::run(&self.state, &self.cycle_gate, root, progress, pre_write).await
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
        let mut live = self
            .live
            .lock()
            .map_err(|_| SyncErrorKind::Io("live task lock poisoned".into()))?;
        *live = Some(live::spawn_live_task(
            Arc::clone(&self.state),
            Arc::clone(&self.cycle_gate),
            root,
            listener,
            pre_write,
        ));
        Ok(())
    }

    pub fn note_changed(&self) {
        if let Ok(live) = self.live.lock() {
            if let Some(task) = live.as_ref() {
                task.notify_note_changed();
            }
        }
    }

    pub fn stop_live(&self) {
        if let Ok(mut live) = self.live.lock() {
            if let Some(task) = live.take() {
                task.abort();
            }
        }
    }

    /// Stop the live task and wait until any cycle already holding the vault is done.
    pub async fn stop_live_and_wait(&self) {
        let live_task = self.live.lock().ok().and_then(|mut live| live.take());
        if let Some(task) = live_task {
            task.stop_and_wait().await;
        }
        let _gate = self.cycle_gate.lock().await;
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
