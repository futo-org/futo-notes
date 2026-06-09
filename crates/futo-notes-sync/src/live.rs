//! SSE-driven live sync.
//!
//! Opens `GET /api/sync/events` and reacts to the server's doorbell events
//! (`ready` / `change` / `ping`). The stream is *lossy across disconnects*
//! (the server replays nothing — see `futo-notes-server/docs/API.md`), so the
//! recovery contract is:
//!
//!   1. pull on every `ready` (a fresh connection is effectively a `ready`),
//!   2. pull (debounced) on every `change`,
//!   3. a periodic safety poll as the catch-all for missed events and for
//!      mutations the server does NOT emit events for (collection
//!      create/delete, key rotation),
//!   4. reconnect with exponential backoff; the new `ready` drives catch-up.
//!
//! It also owns the **write-once auto-push** branch: a `note_changed` signal
//! (fired by the note-write path on every adapter) is debounced and drives a
//! gated push, so a local edit propagates to peers within ~1s with no manual
//! tap. The push is a no-op when disconnected and coalesces an edit burst into
//! a single push.
//!
//! This module owns NONE of the session state. The adapter (FFI / Tauri)
//! supplies a [`LiveHandle`] of async closures: `snapshot` (clone the current
//! session, to build the stream connection) and `cycle` (the *gated*
//! snapshot→run_sync→commit critical section). Both the SSE-driven pull and
//! the write-once auto-push fire the SAME `cycle` — they're just different
//! triggers for "reconcile with the server now". Keeping `cycle` in the
//! adapter is what lets a single sync-gate serialize the live loop against a
//! user-tapped `sync_now`, so the object-map cursor can never regress (see
//! [`crate::session::SyncSession`]).
//!
//! The `change` payload (`{collectionId, currentVersion}`) is used only as a
//! wake signal — we always pull from the locally-persisted `max_version`
//! cursor, which is robust to missed/duplicated events.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio::time::{interval, Instant, MissedTickBehavior};

use crate::orchestrator::SyncCounts;
use crate::state::ConnectedState;

/// A boxed, `'static`, `Send` future — the return type of [`LiveHandle`]'s
/// async closures. Aliased so the adapter layer can name it without importing
/// `futures_util`.
pub type LiveFuture<T> = BoxFuture<'static, T>;

/// Live-sync lifecycle listener. The adapter (FFI / Tauri) implements this to
/// project the loop's events onto its own surface (a UniFFI callback interface,
/// or Tauri `sync:live-state` / `sync:live-synced` events).
///
/// IMPORTANT: these methods fire on a runtime worker thread, NOT a UI thread.
/// Implementations must be cheap and marshal to the main thread before touching
/// UI state, and must NOT call back into a session method that takes a blocking
/// lock (that would deadlock a runtime worker).
pub trait SyncSessionListener: Send + Sync {
    /// A pull (or auto-push) completed; `counts` carries its tallies.
    fn on_synced(&self, counts: SyncCounts);
    /// The stream connected (or reconnected) cleanly.
    fn on_connected(&self);
    /// A non-fatal error; the loop is reconnecting with backoff.
    fn on_error(&self, message: String);
    /// The live loop stopped (cancelled / disconnected / fatal auth error).
    fn on_stopped(&self);
}

/// Hooks the live loop calls into. All session access goes through these so
/// `live.rs` never touches the session mutex directly.
pub struct LiveHandle {
    /// Clone the current connected session (None ⇒ disconnected). Used to
    /// build the SSE connection; takes no lock for longer than a clone.
    pub snapshot: Box<dyn Fn() -> LiveFuture<Option<ConnectedState>> + Send + Sync>,
    /// The gated full cycle: acquire the sync-gate, snapshot, run the adapter's
    /// push-first `run_sync` (push local edits first so a peer edit can't
    /// clobber an unpushed local edit, then pull), commit the advanced state.
    /// `Ok(None)` ⇒ disconnected (the no-op case); `Err` ⇒ a (non-fatal)
    /// failure. Both the SSE pull triggers and the write-once auto-push fire
    /// this same closure under the same gate, so a debounced local push can
    /// never race a live pull's cursor.
    pub cycle: Box<dyn Fn() -> LiveFuture<Result<Option<SyncCounts>, String>> + Send + Sync>,
    /// Lifecycle listener (synced / connected / error / stopped).
    pub listener: Arc<dyn SyncSessionListener>,
}

const SAFETY_POLL: Duration = Duration::from_secs(45);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Debounce window: a burst of `change` events collapses into one pull.
const COALESCE_WINDOW: Duration = Duration::from_millis(300);
/// Debounce window for the write-once auto-push branch: a burst of local edits
/// collapses into a single gated push. ~1s balances coalescing against the
/// <2s cross-device propagation target.
const PUSH_DEBOUNCE: Duration = Duration::from_secs(1);
/// No SSE frame (not even a `ping`) in this long ⇒ the connection is dead.
/// The server heartbeats every 25s, so 90s of silence means reconnect.
const READ_IDLE: Duration = Duration::from_secs(90);

/// Drive live sync until `cancel` fires (or a fatal auth error / disconnect).
/// Spawned on the tokio runtime by [`crate::session::SyncSession::start_live`].
///
/// `note_changed` is the write-once auto-push signal: every local note write
/// sends `()` on it; the loop debounces and runs a gated push. The receiver is
/// drained across reconnects so a local edit during a transient disconnect is
/// not lost — it pushes on the next connected debounce tick.
pub async fn watch(
    handle: LiveHandle,
    mut cancel: mpsc::Receiver<()>,
    mut note_changed: mpsc::Receiver<()>,
) {
    let mut backoff = BACKOFF_MIN;
    let mut safety = interval(SAFETY_POLL);
    safety.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Pending auto-push debounce deadline, shared across reconnects so a local
    // edit isn't dropped if it lands while the stream is down.
    let mut push_at: Option<Instant> = None;

    loop {
        // Build the stream connection from a fresh session snapshot.
        let snap = match (handle.snapshot)().await {
            Some(s) => s,
            None => break, // disconnected
        };
        let http = match crate::orchestrator::build_client(&snap) {
            Ok(c) => c,
            Err(e) => {
                handle.listener.on_error(e.message());
                if sleep_or_cancel(backoff, &mut cancel).await {
                    handle.listener.on_stopped();
                    return;
                }
                backoff = (backoff * 2).min(BACKOFF_MAX);
                continue;
            }
        };
        let response = match http.open_event_stream().await {
            Ok(r) => r,
            Err(e) => {
                if e.is_unauthorized() {
                    handle.listener.on_error(format!("auth: {e}"));
                    handle.listener.on_stopped();
                    return; // token is dead — reconnecting won't help
                }
                handle.listener.on_error(format!("connect: {e}"));
                if sleep_or_cancel(backoff, &mut cancel).await {
                    handle.listener.on_stopped();
                    return;
                }
                backoff = (backoff * 2).min(BACKOFF_MAX);
                continue;
            }
        };
        backoff = BACKOFF_MIN; // clean connect → reset
        handle.listener.on_connected();

        // A fresh connection is effectively a `ready` — catch up now.
        run_cycle(&handle).await;

        let byte_stream = response.bytes_stream();
        tokio::pin!(byte_stream);
        let mut decoder = SseDecoder::default();
        let mut coalesce: Option<Instant> = None;

        let reconnect = loop {
            let coalesce_fire = async {
                match coalesce {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending::<()>().await,
                }
            };
            let push_fire = async {
                match push_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                biased;
                _ = cancel.recv() => {
                    handle.listener.on_stopped();
                    return;
                }
                // Write-once auto-push: a debounced local edit drives a gated
                // push. No-op (Ok(None)) when disconnected.
                Some(()) = note_changed.recv() => {
                    push_at = Some(Instant::now() + PUSH_DEBOUNCE);
                }
                _ = push_fire => {
                    push_at = None;
                    run_cycle(&handle).await;
                }
                _ = safety.tick() => run_cycle(&handle).await,
                _ = coalesce_fire => {
                    coalesce = None;
                    run_cycle(&handle).await;
                }
                chunk = tokio::time::timeout(READ_IDLE, byte_stream.next()) => {
                    match chunk {
                        Err(_idle) => break true,                 // read-idle → reconnect
                        Ok(None) => break true,                   // EOF → reconnect
                        Ok(Some(Err(e))) => {
                            handle.listener.on_error(format!("stream: {e}"));
                            break true;
                        }
                        Ok(Some(Ok(bytes))) => {
                            let mut events = Vec::new();
                            decoder.push(&bytes, &mut events);
                            for name in events {
                                match name.as_str() {
                                    "ready" => run_cycle(&handle).await,
                                    "ping" => {} // heartbeat
                                    // `change` and any unnamed/unknown event:
                                    // debounce a pull.
                                    _ => coalesce = Some(Instant::now() + COALESCE_WINDOW),
                                }
                            }
                        }
                    }
                }
            }
        };

        if reconnect {
            if sleep_or_cancel(backoff, &mut cancel).await {
                handle.listener.on_stopped();
                return;
            }
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    }

    handle.listener.on_stopped();
}

async fn run_cycle(handle: &LiveHandle) {
    match (handle.cycle)().await {
        Ok(Some(counts)) => handle.listener.on_synced(counts),
        Ok(None) => {} // disconnected — nothing to reconcile
        Err(msg) => handle.listener.on_error(msg),
    }
}

/// Sleep for `d`, or return `true` early if cancellation fired.
async fn sleep_or_cancel(d: Duration, cancel: &mut mpsc::Receiver<()>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(d) => false,
        _ = cancel.recv() => true,
    }
}

/// Minimal incremental SSE frame parser. Emits the `event:` name of each
/// dispatched event (the empty string for an unnamed/default event). Comment
/// lines (`:` heartbeats) never dispatch. We don't need the `data:` payload —
/// events are doorbells; the pull reads from the persisted cursor.
#[derive(Default)]
struct SseDecoder {
    buf: Vec<u8>,
    event: String,
    /// True once a non-comment field has been seen for the current event, so a
    /// blank line dispatches (and a comment-only block does not).
    pending: bool,
}

impl SseDecoder {
    fn push(&mut self, chunk: &[u8], out: &mut Vec<String>) {
        self.buf.extend_from_slice(chunk);
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=nl).collect();
            line.pop(); // drop '\n'
            if line.last() == Some(&b'\r') {
                line.pop(); // drop '\r' (CRLF)
            }
            let line = String::from_utf8_lossy(&line);
            if line.is_empty() {
                if self.pending {
                    out.push(std::mem::take(&mut self.event));
                }
                self.event.clear();
                self.pending = false;
            } else if line.starts_with(':') {
                // comment / heartbeat — ignore, don't arm dispatch
            } else if let Some(rest) = line.strip_prefix("event:") {
                self.event = rest.strip_prefix(' ').unwrap_or(rest).to_owned();
                self.pending = true;
            } else {
                // data:/id:/retry:/unknown — payload ignored, but arm dispatch
                // so a data-only (default-named) event still wakes a pull.
                self.pending = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(chunks: &[&str]) -> Vec<String> {
        let mut d = SseDecoder::default();
        let mut out = Vec::new();
        for c in chunks {
            d.push(c.as_bytes(), &mut out);
        }
        out
    }

    #[test]
    fn parses_named_events() {
        assert_eq!(
            names(&["event: ready\ndata: \n\nevent: change\ndata: {\"x\":1}\n\n"]),
            vec!["ready".to_string(), "change".to_string()]
        );
    }

    #[test]
    fn ignores_comment_heartbeat() {
        // A `:` comment block must NOT dispatch.
        assert_eq!(names(&[": keep-alive\n\nevent: ping\ndata: \n\n"]), vec!["ping"]);
    }

    #[test]
    fn handles_crlf_and_split_chunks() {
        // Event split across two network chunks, CRLF line endings.
        assert_eq!(
            names(&["event: chan", "ge\r\ndata: {}\r\n\r\n"]),
            vec!["change"]
        );
    }

    #[test]
    fn multiline_data_dispatches_once() {
        assert_eq!(
            names(&["event: change\ndata: line1\ndata: line2\n\n"]),
            vec!["change"]
        );
    }
}
