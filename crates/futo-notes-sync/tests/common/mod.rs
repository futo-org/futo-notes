//! Shared helpers for the live-server integration suites.
//!
//! These tests talk to a REAL `futo-notes-server` over HTTP, so they are
//! `#[ignore]`d by default and only run when `FUTO_TEST_SERVER` points at a
//! running server, e.g.:
//!
//!   FUTO_TEST_SERVER=http://127.0.0.1:3005 \
//!     cargo test -p futo-notes-sync --test server_integration --test sse_live \
//!     -- --ignored --test-threads=1
//!
//! The dev login is a FIXED identity (`local@futo-notes.local`), so every run
//! shares ONE user/collection/vault. Tests therefore use unique note names and
//! assert on DELTAS (counts, presence of their own files, cursor advance) —
//! never on absolute object totals — and run single-threaded.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// Shared password (and thus vault key) for all test clients this run.
pub const TEST_PASSWORD: &str = "integration-test-password";

/// Base URL of the server under test, or `None` when the suite should skip.
pub fn server_url() -> Option<String> {
    match std::env::var("FUTO_TEST_SERVER") {
        Ok(s) if !s.trim().is_empty() => Some(s),
        _ => None,
    }
}

/// `true` + an eprintln when there's no server configured (so the test returns
/// early instead of failing). Pattern: `if skip_if_no_server("name") { return; }`
pub fn skip_if_no_server(test: &str) -> bool {
    if server_url().is_none() {
        eprintln!("[skip] {test}: set FUTO_TEST_SERVER=http://127.0.0.1:3005 to run");
        true
    } else {
        false
    }
}

/// A process-unique token for collision-free note names / ids.
pub fn unique(prefix: &str) -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{n}", futo_notes_core::files::now_ms())
}

/// A fresh, empty throwaway vault directory.
pub fn temp_vault() -> PathBuf {
    let dir = std::env::temp_dir().join(unique("futo-it-vault"));
    std::fs::create_dir_all(&dir).expect("create temp vault");
    dir
}

/// Remove a temp vault (best effort).
pub fn cleanup(dir: &PathBuf) {
    let _ = std::fs::remove_dir_all(dir);
}
