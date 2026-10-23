use std::path::PathBuf;
use std::sync::Arc;

use futo_notes_sync::{SyncProgress, SyncSession, SyncSessionListener};

use super::{
    off_caller, session_listener, ConnectInfo, SyncError, SyncEventListener, SyncStatus,
    SyncSummary,
};

// Native shells have neither watcher suppression nor per-phase progress UI.
fn no_progress(_progress: SyncProgress) {}
fn no_pre_write(_filename: &str) {}

#[derive(uniffi::Object)]
pub struct SyncClient {
    notes_root: PathBuf,
    server_url: String,
    session: SyncSession,
}

impl SyncClient {
    /// What signing out of hosted sync needs to demote this vault's state by
    /// the same route `disconnect` does, rather than a second teardown that
    /// has to be kept in step with it.
    pub(crate) fn parts(&self) -> (&SyncSession, &std::path::Path) {
        (&self.session, &self.notes_root)
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl SyncClient {
    #[uniffi::constructor]
    pub fn new(notes_root: String, server_url: String) -> Arc<Self> {
        Arc::new(Self {
            notes_root: PathBuf::from(notes_root),
            server_url,
            session: SyncSession::new(),
        })
    }

    pub async fn connect(self: Arc<Self>, password: String) -> Result<ConnectInfo, SyncError> {
        off_caller(async move {
            let connected = self
                .session
                .connect(&self.notes_root, &self.server_url, &password)
                .await?;
            Ok(ConnectInfo {
                user_id: connected.user_id,
                collection_id: connected.collection_id,
                auth_mode: connected.auth_mode.to_owned(),
            })
        })
        .await
    }

    /// Runs a serialized push-first cycle without holding the status lock during network I/O.
    pub async fn sync_now(self: Arc<Self>) -> Result<SyncSummary, SyncError> {
        off_caller(async move {
            self.session
                .sync(&self.notes_root, &no_progress, &no_pre_write)
                .await
                .map(Into::into)
                .map_err(Into::into)
        })
        .await
    }

    pub fn status(&self) -> SyncStatus {
        match self.session.status() {
            None => SyncStatus {
                connected: false,
                server_url: None,
                user_id: None,
                collection_id: None,
                max_version: 0,
                object_count: 0,
            },
            Some(connected) => SyncStatus {
                connected: true,
                server_url: Some(connected.base_url),
                user_id: Some(connected.user_id),
                collection_id: Some(connected.collection_id),
                max_version: connected.max_version,
                object_count: connected.object_map.len() as u32,
            },
        }
    }

    pub fn note_changed(&self) {
        self.session.note_changed();
    }

    pub async fn start_live(
        self: Arc<Self>,
        listener: Box<dyn SyncEventListener>,
    ) -> Result<(), SyncError> {
        let listener: Arc<dyn SyncSessionListener> = session_listener(listener);
        // Asked for here, on the caller's own poll, so a `stop_live` the shell
        // makes before the runtime gets to the body still voids it (#278).
        let start =
            self.session
                .start_live(self.notes_root.clone(), listener, Arc::new(no_pre_write));
        off_caller(async move { start.await.map_err(Into::into) }).await
    }

    pub fn stop_live(&self) {
        self.session.stop_live();
    }

    /// Stops live sync and waits for any in-flight cycle to release the vault.
    /// The stop takes effect on the caller's poll; only the wait runs off it.
    pub async fn stop_live_and_wait(self: Arc<Self>) {
        off_caller(self.session.stop_live_and_wait()).await
    }

    /// Disconnect drops live cursor state but preserves verified ancestry for safe reconciliation
    /// after reconnect.
    pub async fn disconnect(self: Arc<Self>) -> Result<(), SyncError> {
        off_caller(async move {
            self.session
                .disconnect(&self.notes_root)
                .await
                .map_err(Into::into)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::task::Poll;

    use futo_notes_sync::HostedCredentials;

    use super::*;

    /// Reports when the last holder lets go of it. A live task keeps its
    /// listener for as long as it runs, so a dropped listener after
    /// `start_live` returns means no live task was left behind.
    struct Listener(Arc<AtomicBool>);

    impl Drop for Listener {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    impl SyncEventListener for Listener {
        fn on_synced(&self, _summary: SyncSummary) {}
        fn on_connected(&self) {}
        fn on_error(&self, _message: String) {}
        fn on_stopped(&self) {}
    }

    /// #278. The shell's first poll of `start_live` only queues its body on
    /// the runtime (`off_caller`); Android backgrounding the app before that
    /// body runs calls `stop_live`, which must still win. A current-thread
    /// runtime holds the queued body until the test awaits it, which forces
    /// exactly that interleaving.
    #[tokio::test]
    async fn stop_live_before_the_queued_start_live_runs_leaves_no_live_task() {
        let root = std::env::temp_dir().join(format!("ffi-live-race-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let client = SyncClient::new(
            root.to_string_lossy().into_owned(),
            "http://127.0.0.1:1".to_owned(),
        );
        client
            .session
            .connect_hosted(
                &root,
                HostedCredentials {
                    server_url: "http://127.0.0.1:1".to_owned(),
                    token: "token".to_owned(),
                    user_id: "user".to_owned(),
                    collection_id: "collection".to_owned(),
                    vault_key: [3; 32],
                },
            )
            .await
            .unwrap();
        let released = Arc::new(AtomicBool::new(false));

        let mut start = Box::pin(
            client
                .clone()
                .start_live(Box::new(Listener(Arc::clone(&released)))),
        );
        let first_poll = std::future::poll_fn(|cx| Poll::Ready(start.as_mut().poll(cx))).await;
        assert!(
            first_poll.is_pending(),
            "the body should be queued, not run"
        );
        client.stop_live();
        start.await.unwrap();

        let leaked = !released.load(Ordering::SeqCst);
        client.stop_live();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(!leaked, "a live task is running after stop_live");
    }
}
