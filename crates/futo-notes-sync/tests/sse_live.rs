//! Live-server SSE tests: prove a `SyncSession` auto-pulls a peer's
//! change, and that a reconnect catches a change missed while disconnected.
//!
//! Gated on `FUTO_TEST_SERVER` (skipped otherwise) — see `tests/common/mod.rs`.

mod common;

use std::sync::Arc;
use std::time::Duration;

use futo_notes_sync::{SyncProgress, SyncSession, SyncSessionListener, SyncSummary};

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

struct Recorder(Arc<std::sync::Mutex<Recorded>>);

impl SyncSessionListener for Recorder {
    fn on_synced(&self, summary: SyncSummary) {
        let mut g = self.0.lock().unwrap();
        g.synced += 1;
        g.downloaded += summary.downloaded;
    }
    fn on_connected(&self) {
        self.0.lock().unwrap().connected += 1;
    }
    fn on_error(&self, message: String) {
        self.0.lock().unwrap().errors.push(message);
    }
    fn on_stopped(&self) {}
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
    let session = SyncSession::new();
    session
        .connect(&vault_a, &server, common::TEST_PASSWORD)
        .await
        .expect("A connect");
    let rec = Arc::new(std::sync::Mutex::new(Recorded::default()));
    session
        .start_live(
            vault_a.clone(),
            Arc::new(Recorder(rec.clone())),
            Arc::new(no_pre_write),
        )
        .await
        .expect("start live");

    // Stream connects + does its initial catch-up pull.
    assert!(
        wait_until(
            || rec.lock().unwrap().connected >= 1,
            Duration::from_secs(8)
        )
        .await,
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

    session.stop_live();

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
    let session = SyncSession::new();
    session
        .connect(&vault_a, &server, common::TEST_PASSWORD)
        .await
        .expect("A connect");
    let rec = Arc::new(std::sync::Mutex::new(Recorded::default()));

    // First session, then tear the stream down (simulate going offline).
    session
        .start_live(
            vault_a.clone(),
            Arc::new(Recorder(rec.clone())),
            Arc::new(no_pre_write),
        )
        .await
        .expect("start live");
    assert!(
        wait_until(
            || rec.lock().unwrap().connected >= 1,
            Duration::from_secs(8)
        )
        .await,
        "live stream never connected; errors={:?}",
        rec.lock().unwrap().errors
    );
    session.stop_live();

    // Peer pushes while A is down — the `change` event is fired into the void
    // (the server replays nothing).
    let title = common::unique("recon-note");
    let body = "missed while offline";
    assert_eq!(peer_push(&server, "", &title, body).await, 1);

    // Reconnect: the fresh `ready` (initial pull) must catch the missed note.
    session
        .start_live(
            vault_a.clone(),
            Arc::new(Recorder(rec.clone())),
            Arc::new(no_pre_write),
        )
        .await
        .expect("restart live");

    let note_path = vault_a.join(format!("{title}.md"));
    let caught = wait_until(|| note_path.exists(), Duration::from_secs(8)).await;

    session.stop_live();

    assert!(
        caught,
        "reconnect did not catch the missed note; errors={:?}",
        rec.lock().unwrap().errors
    );
    assert_eq!(std::fs::read_to_string(&note_path).unwrap(), body);
    common::cleanup(&vault_a);
}
