//! Live-server SSE tests: prove the `live::watch` loop auto-pulls a peer's
//! change, and that a reconnect catches a change missed while disconnected.
//!
//! Gated on `FUTO_TEST_SERVER` (skipped otherwise) — see `tests/common/mod.rs`.

mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futo_notes_sync::live::{watch, LiveFuture, LiveHandle, SyncSessionListener};
use futo_notes_sync::state::ConnectedState;
use futo_notes_sync::{SyncCounts, SyncProgress};
use tokio::sync::{mpsc, Mutex};

/// No-op sync hooks (no progress UI, no watcher to suppress in the test).
fn no_progress(_p: SyncProgress) {}
fn no_pre_write(_f: &str) {}

#[derive(Default)]
struct Recorded {
    connected: u32,
    synced: u32,
    downloaded: u32,
    errors: Vec<String>,
}

/// Records the live loop's lifecycle callbacks. Implements the new
/// `SyncSessionListener` trait the loop projects events onto (replacing the
/// old per-callback `LiveHandle` fields).
struct Recorder(Arc<std::sync::Mutex<Recorded>>);

impl SyncSessionListener for Recorder {
    fn on_synced(&self, counts: SyncCounts) {
        let mut g = self.0.lock().unwrap();
        g.synced += 1;
        g.downloaded += counts.downloaded;
    }
    fn on_connected(&self) {
        self.0.lock().unwrap().connected += 1;
    }
    fn on_error(&self, message: String) {
        self.0.lock().unwrap().errors.push(message);
    }
    fn on_stopped(&self) {}
}

/// Build a `LiveHandle` over a shared session cell, recording callbacks. This
/// mirrors what `SyncClient::start_live` does in the FFI layer, minus the
/// sync-gate (the test is the only consumer).
fn make_handle(
    state: Arc<Mutex<Option<ConnectedState>>>,
    rec: Arc<std::sync::Mutex<Recorded>>,
    vault: PathBuf,
) -> LiveHandle {
    LiveHandle {
        snapshot: {
            let state = state.clone();
            Box::new(move || -> LiveFuture<Option<ConnectedState>> {
                let state = state.clone();
                Box::pin(async move { state.lock().await.clone() })
            })
        },
        cycle: {
            let state = state.clone();
            let vault = vault.clone();
            Box::new(move || -> LiveFuture<Result<Option<SyncCounts>, String>> {
                let state = state.clone();
                let vault = vault.clone();
                Box::pin(async move {
                    let snap = match state.lock().await.clone() {
                        Some(s) => s,
                        None => return Ok(None),
                    };
                    let (summary, after) =
                        futo_notes_sync::run_sync(&snap, &vault, &no_progress, &no_pre_write)
                            .await
                            .map_err(|e| format!("{e:?}"))?;
                    *state.lock().await = Some(after);
                    Ok(Some((&summary).into()))
                })
            })
        },
        listener: Arc::new(Recorder(rec)),
    }
}

/// Connect a throwaway peer, write one note, push it. Returns `uploaded`.
async fn peer_push(server: &str, folder: &str, title: &str, body: &str) -> u32 {
    let vault = common::temp_vault();
    let (state, _info) = futo_notes_sync::connect(&vault, server, common::TEST_PASSWORD)
        .await
        .expect("peer connect");
    let rel = if folder.is_empty() {
        format!("{title}.md")
    } else {
        format!("{folder}/{title}.md")
    };
    let path = vault.join(&rel);
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(&path, body).unwrap();
    let (counts, _next) = futo_notes_sync::run_push(&state, &vault, &no_progress, &no_pre_write)
        .await
        .expect("peer push");
    common::cleanup(&vault);
    counts.uploaded
}

/// Poll `cond` every 100ms until true or `timeout` elapses.
async fn wait_until(cond: impl Fn() -> bool, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if cond() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn auto_pull_on_peer_push() {
    if common::skip_if_no_server("auto_pull_on_peer_push") {
        return;
    }
    let server = common::server_url().unwrap();

    let vault_a = common::temp_vault();
    let (a_state, _info) = futo_notes_sync::connect(&vault_a, &server, common::TEST_PASSWORD)
        .await
        .expect("A connect");
    let state = Arc::new(Mutex::new(Some(a_state)));
    let rec = Arc::new(std::sync::Mutex::new(Recorded::default()));

    let (cancel_tx, cancel_rx) = mpsc::channel(1);
    // Auto-push signal: held but never fired (these tests exercise pull only).
    let (_note_tx, note_rx) = mpsc::channel(1);
    let handle = make_handle(state.clone(), rec.clone(), vault_a.clone());
    let join = tokio::spawn(watch(handle, cancel_rx, note_rx));

    // Stream connects + does its initial catch-up pull.
    assert!(
        wait_until(|| rec.lock().unwrap().connected >= 1, Duration::from_secs(8)).await,
        "live stream never connected; errors={:?}",
        rec.lock().unwrap().errors
    );

    // A peer pushes a uniquely-named note.
    let title = common::unique("sse-note");
    let body = "hello from the peer";
    let uploaded = peer_push(&server, "", &title, body).await;
    assert_eq!(uploaded, 1, "peer should have uploaded exactly its note");

    // A must auto-pull it (no manual sync) — assert on the file, robust to any
    // pre-existing objects in the shared collection.
    let note_path = vault_a.join(format!("{title}.md"));
    let got = wait_until(|| note_path.exists(), Duration::from_secs(8)).await;

    let _ = cancel_tx.send(()).await;
    let _ = tokio::time::timeout(Duration::from_secs(3), join).await;

    assert!(
        got,
        "client A did not auto-pull the peer note; downloaded={}, errors={:?}",
        rec.lock().unwrap().downloaded,
        rec.lock().unwrap().errors
    );
    assert_eq!(std::fs::read_to_string(&note_path).unwrap(), body);
    common::cleanup(&vault_a);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn reconnect_catches_missed_change() {
    if common::skip_if_no_server("reconnect_catches_missed_change") {
        return;
    }
    let server = common::server_url().unwrap();

    let vault_a = common::temp_vault();
    let (a_state, _info) = futo_notes_sync::connect(&vault_a, &server, common::TEST_PASSWORD)
        .await
        .expect("A connect");
    let state = Arc::new(Mutex::new(Some(a_state)));
    let rec = Arc::new(std::sync::Mutex::new(Recorded::default()));

    // First session, then tear the stream down (simulate going offline).
    let (c1_tx, c1_rx) = mpsc::channel(1);
    let (_n1_tx, n1_rx) = mpsc::channel(1);
    let h1 = make_handle(state.clone(), rec.clone(), vault_a.clone());
    let j1 = tokio::spawn(watch(h1, c1_rx, n1_rx));
    assert!(
        wait_until(|| rec.lock().unwrap().connected >= 1, Duration::from_secs(8)).await,
        "live stream never connected; errors={:?}",
        rec.lock().unwrap().errors
    );
    let _ = c1_tx.send(()).await;
    let _ = tokio::time::timeout(Duration::from_secs(3), j1).await;

    // Peer pushes while A is down — the `change` event is fired into the void
    // (the server replays nothing).
    let title = common::unique("recon-note");
    let body = "missed while offline";
    assert_eq!(peer_push(&server, "", &title, body).await, 1);

    // Reconnect: the fresh `ready` (initial pull) must catch the missed note.
    let (c2_tx, c2_rx) = mpsc::channel(1);
    let (_n2_tx, n2_rx) = mpsc::channel(1);
    let h2 = make_handle(state.clone(), rec.clone(), vault_a.clone());
    let j2 = tokio::spawn(watch(h2, c2_rx, n2_rx));

    let note_path = vault_a.join(format!("{title}.md"));
    let caught = wait_until(|| note_path.exists(), Duration::from_secs(8)).await;

    let _ = c2_tx.send(()).await;
    let _ = tokio::time::timeout(Duration::from_secs(3), j2).await;

    assert!(
        caught,
        "reconnect did not catch the missed note; errors={:?}",
        rec.lock().unwrap().errors
    );
    assert_eq!(std::fs::read_to_string(&note_path).unwrap(), body);
    common::cleanup(&vault_a);
}
