//! Sync-cycle cost harness (ignored; needs a live isolated server).
//!
//! Measures what one sync cycle costs when the vault is already in sync — the
//! shape ~95% of real cycles take (safety poll, manual, remote-change echo).
//! Reports wall time per cycle, TCP connections opened per cycle, and whether
//! the checkpoint file was rewritten.
//!
//!   FUTO_TEST_SERVER=http://127.0.0.1:3055 cargo test -p futo-notes-sync \
//!     --test perf_cycle -- --ignored --nocapture
//!
//! Vault size defaults to 500 notes; override with FUTO_PERF_NOTES.

mod common;

use std::path::Path;
use std::time::Instant;

use futo_notes_sync::SyncProgress;

fn no_progress(_p: SyncProgress) {}
fn no_pre_write(_f: &str) {}

fn port_of(server: &str) -> String {
    server
        .rsplit(':')
        .next()
        .unwrap_or("")
        .trim_end_matches('/')
        .to_owned()
}

/// Sockets in any state whose peer is the server port, from `ss`. TIME-WAIT
/// entries are connections this process opened and closed; ESTABLISHED are
/// live pooled connections.
fn socket_counts(port: &str) -> (usize, usize) {
    let out = std::process::Command::new("ss")
        .args(["-tan"])
        .output()
        .expect("ss");
    let text = String::from_utf8_lossy(&out.stdout);
    let mut time_wait = 0;
    let mut established = 0;
    for line in text.lines() {
        if !line.contains(&format!(":{port} ")) && !line.ends_with(&format!(":{port}")) {
            continue;
        }
        if line.starts_with("TIME-WAIT") {
            time_wait += 1;
        } else if line.starts_with("ESTAB") {
            established += 1;
        }
    }
    (time_wait, established)
}

fn checkpoint_mtime(vault: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(vault.join(".e2ee-state.json"))
        .and_then(|m| m.modified())
        .ok()
}

fn percentile(sorted: &[u128], p: f64) -> u128 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

#[tokio::test]
#[ignore]
async fn noop_cycle_cost() {
    if common::skip_if_no_server("noop_cycle_cost") {
        return;
    }
    let server = common::server_url().unwrap();
    let port = port_of(&server);
    let notes: usize = std::env::var("FUTO_PERF_NOTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(500);
    let vault = common::temp_vault();
    for i in 0..notes {
        std::fs::write(
            vault.join(format!("perf note {i:05}.md")),
            format!("# perf note {i}\n\nbody line one\nbody line two\n"),
        )
        .unwrap();
    }

    let (state, _info) = futo_notes_sync::connect(&vault, &server, common::TEST_PASSWORD)
        .await
        .expect("connect");
    let started = Instant::now();
    let (summary, state) = futo_notes_sync::run_sync(&state, &vault, &no_progress, &no_pre_write)
        .await
        .expect("initial upload");
    eprintln!(
        "seed: pushed {} notes in {} ms",
        summary.uploaded,
        started.elapsed().as_millis()
    );

    // Warm-up cycle so the very first no-op's one-off costs are excluded.
    let (_, mut state) = futo_notes_sync::run_sync(&state, &vault, &no_progress, &no_pre_write)
        .await
        .expect("warm-up");

    let cycles = 20;
    let (tw0, est0) = socket_counts(&port);
    let mtime0 = checkpoint_mtime(&vault);
    let mut durations = Vec::with_capacity(cycles);
    let mut rewrites = 0;
    for _ in 0..cycles {
        let before = checkpoint_mtime(&vault);
        std::thread::sleep(std::time::Duration::from_millis(5));
        let t = Instant::now();
        let (summary, next) =
            futo_notes_sync::run_sync(&state, &vault, &no_progress, &no_pre_write)
                .await
                .expect("noop cycle");
        durations.push(t.elapsed().as_micros());
        assert_eq!(summary.uploaded, 0);
        assert_eq!(summary.downloaded, 0);
        if checkpoint_mtime(&vault) != before {
            rewrites += 1;
        }
        state = next;
    }
    let (tw1, est1) = socket_counts(&port);
    durations.sort_unstable();
    let size = std::fs::metadata(vault.join(".e2ee-state.json"))
        .map(|m| m.len())
        .unwrap_or(0);
    eprintln!("--- no-op sync cycle, {notes} notes, {cycles} cycles ---");
    eprintln!(
        "cycle wall time: p50 {:.1} ms, p90 {:.1} ms, min {:.1} ms",
        percentile(&durations, 0.5) as f64 / 1000.0,
        percentile(&durations, 0.9) as f64 / 1000.0,
        durations[0] as f64 / 1000.0
    );
    eprintln!(
        "tcp connections closed (TIME-WAIT delta): {} ({:.1} per cycle); established before/after: {}/{}",
        tw1.saturating_sub(tw0),
        tw1.saturating_sub(tw0) as f64 / cycles as f64,
        est0,
        est1
    );
    eprintln!(
        "checkpoint rewritten on {rewrites}/{cycles} no-op cycles ({size} bytes each; first mtime changed: {})",
        mtime0 != checkpoint_mtime(&vault)
    );
    common::cleanup(&vault);
}
