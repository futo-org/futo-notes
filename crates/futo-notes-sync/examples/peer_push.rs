//! `peer_push` — a tiny second-client CLI for testing live sync.
//!
//! Connects to the sync server with the SAME (fixed dev) identity the native
//! app uses, writes one note into a throwaway vault, and pushes it. Because the
//! dev login is a fixed identity (`local@futo-notes.local`), the note lands in
//! the same collection/vault any other client is watching — so it's a valid
//! "peer change" for verifying SSE auto-pull, both in `tests/sse_live.rs` and
//! in manual on-device QA.
//!
//! Usage:
//!   cargo run -p futo-notes-sync --example peer_push -- \
//!     <server_url> <password> <title> <body> [--folder F] [--vault DIR]
//!
//! Example:
//!   cargo run -p futo-notes-sync --example peer_push -- \
//!     http://127.0.0.1:3005 test "Peer note" "hello from the peer" --folder Specs

use std::path::PathBuf;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut server = None;
    let mut password = None;
    let mut title = None;
    let mut body = None;
    let mut folder = String::new();
    let mut vault: Option<PathBuf> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--folder" => folder = args.next().unwrap_or_default(),
            "--vault" => vault = args.next().map(PathBuf::from),
            other if server.is_none() => server = Some(other.to_owned()),
            other if password.is_none() => password = Some(other.to_owned()),
            other if title.is_none() => title = Some(other.to_owned()),
            other if body.is_none() => body = Some(other.to_owned()),
            other => {
                eprintln!("unexpected argument: {other}");
                std::process::exit(2);
            }
        }
    }

    let (server, password, title, body) = match (server, password, title, body) {
        (Some(s), Some(p), Some(t), Some(b)) => (s, p, t, b),
        _ => {
            eprintln!(
                "usage: peer_push <server_url> <password> <title> <body> [--folder F] [--vault DIR]"
            );
            std::process::exit(2);
        }
    };

    let vault = vault.unwrap_or_else(|| {
        std::env::temp_dir().join(format!("futo-peer-{}", futo_notes_core::files::now_ms()))
    });
    std::fs::create_dir_all(&vault).expect("create vault dir");

    // Connect (probe auth, login, pick/create collection, fetch+unwrap vault key).
    let (state, info) = futo_notes_sync::connect(&vault, &server, &password)
        .await
        .expect("connect");

    // Write the note at <folder>/<title>.md, then push it.
    let rel = if folder.is_empty() {
        format!("{title}.md")
    } else {
        format!("{folder}/{title}.md")
    };
    let path = vault.join(&rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create note folder");
    }
    std::fs::write(&path, &body).expect("write note");

    let no_progress = |_p: futo_notes_sync::SyncProgress| {};
    let no_pre_write = |_f: &str| {};
    let (counts, _next) =
        futo_notes_sync::run_push(&state, &vault, &no_progress, &no_pre_write)
            .await
            .expect("push");

    println!(
        "peer connected user={} collection={} auth={} — pushed {rel} (uploaded={})",
        info.user_id, info.collection_id, info.auth_mode, counts.uploaded
    );
}
