use std::path::Path;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::checkpoint::{self, ConnectedState};
use crate::sync::{self, PreWrite, Progress, SaveCheckpoint, SyncErrorKind, SyncSummary};

pub(super) async fn run(
    state: &Arc<Mutex<Option<ConnectedState>>>,
    gate: &Arc<Mutex<()>>,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
) -> Result<SyncSummary, SyncErrorKind> {
    run_with_checkpoint(state, gate, root, progress, pre_write, &checkpoint::save).await
}

async fn run_with_checkpoint(
    state: &Arc<Mutex<Option<ConnectedState>>>,
    gate: &Arc<Mutex<()>>,
    root: &Path,
    progress: &Progress,
    pre_write: &PreWrite,
    save_checkpoint: &SaveCheckpoint,
) -> Result<SyncSummary, SyncErrorKind> {
    let _gate = gate.lock().await;
    let current = state
        .lock()
        .await
        .clone()
        .ok_or(SyncErrorKind::NotConnected)?;
    match sync::cycle_with_checkpoint(&current, root, progress, pre_write, save_checkpoint).await {
        Ok((summary, next)) => {
            *state.lock().await = Some(next);
            Ok(summary)
        }
        Err(failure) => {
            *state.lock().await = Some(failure.state);
            Err(failure.kind)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};

    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "futo-sync-session-checkpoint-test-{}-{n}",
                futo_notes_core::files::now_ms()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct MutationServer {
        base_url: String,
        posts: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    fn read_request(stream: &mut TcpStream) -> std::io::Result<String> {
        const MAX_REQUEST_BYTES: usize = 1024 * 1024;
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        let (header_end, content_length) = loop {
            let read = stream.read(&mut chunk)?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "request ended before headers",
                ));
            }
            request.extend_from_slice(&chunk[..read]);
            if request.len() > MAX_REQUEST_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "request exceeds test server limit",
                ));
            }
            let Some(header_end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            break (header_end + 4, content_length);
        };

        while request.len() < header_end + content_length {
            let read = stream.read(&mut chunk)?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "request ended before body",
                ));
            }
            request.extend_from_slice(&chunk[..read]);
            if request.len() > MAX_REQUEST_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "request exceeds test server limit",
                ));
            }
        }

        Ok(String::from_utf8_lossy(&request[..header_end]).into_owned())
    }

    fn serve_mutation_request(
        stream: &mut TcpStream,
        posts: &AtomicUsize,
        remote_blob: Option<&[u8]>,
        fail_pull: bool,
    ) -> std::io::Result<()> {
        let request = read_request(stream)?;
        let request_line = request.lines().next().unwrap_or_default();
        let (status, content_type, body) = if request_line
            .starts_with("POST /api/collections/collection/blob-objects ")
        {
            let post = posts.fetch_add(1, Ordering::Relaxed) + 1;
            let body = format!(
                r#"{{"object":{{"id":"posted-{post}","version":1,"change_seq":{post},"deleted":false,"blob_key":"posted-blob-{post}","updated_at":"2026-07-20T00:00:00Z"}},"collectionVersion":{post}}}"#
            )
            .into_bytes();
            ("200 OK", "application/json", body)
        } else if request_line.starts_with("GET /api/collections/collection/objects?sinceVersion=")
        {
            if fail_pull {
                (
                    "500 Internal Server Error",
                    "application/json",
                    br#"{"error":"injected pull failure"}"#.to_vec(),
                )
            } else {
                let since = request_line
                    .split("sinceVersion=")
                    .nth(1)
                    .and_then(|tail| tail.split_whitespace().next())
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(0);
                let body = if remote_blob.is_some() && since < 2 {
                    r#"{"objects":[{"id":"remote-object","version":1,"change_seq":2,"deleted":false,"blob_key":"remote-blob","updated_at":"2026-07-20T00:00:00Z"}]}"#
                } else {
                    r#"{"objects":[]}"#
                };
                ("200 OK", "application/json", body.as_bytes().to_vec())
            }
        } else if request_line.starts_with("GET /api/blobs/remote-blob ") {
            (
                "200 OK",
                "application/octet-stream",
                remote_blob.unwrap_or_default().to_vec(),
            )
        } else {
            (
                "200 OK",
                "application/json",
                r#"{"error":"unexpected test request"}"#.as_bytes().to_vec(),
            )
        };
        write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )?;
        stream.write_all(&body)?;
        stream.flush()
    }

    impl MutationServer {
        fn new() -> Self {
            Self::with_remote(None, false)
        }

        fn with_pull_failure() -> Self {
            Self::with_remote(None, true)
        }

        fn with_remote_note(vault_key: &[u8; 32], name: &str, content: &str) -> Self {
            let plaintext = futo_notes_core::e2ee::pack_note_v2(name, content);
            let ciphertext = futo_notes_core::e2ee::aes_gcm_encrypt(vault_key, &plaintext).unwrap();
            Self::with_remote(Some(ciphertext), false)
        }

        fn with_remote(remote_blob: Option<Vec<u8>>, fail_pull: bool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let posts = Arc::new(AtomicUsize::new(0));
            let observed_posts = Arc::clone(&posts);
            let stop = Arc::new(AtomicBool::new(false));
            let should_stop = Arc::clone(&stop);
            let handle = std::thread::spawn(move || loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if should_stop.load(Ordering::Relaxed) {
                            break;
                        }
                        let _ = serve_mutation_request(
                            &mut stream,
                            &observed_posts,
                            remote_blob.as_deref(),
                            fail_pull,
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => panic!("mutation server failed: {error}"),
                }
            });
            Self {
                base_url: format!("http://{address}"),
                posts,
                stop,
                handle: Some(handle),
            }
        }
    }

    impl Drop for MutationServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            let _ = std::net::TcpStream::connect(self.base_url.trim_start_matches("http://"));
            if let Some(handle) = self.handle.take() {
                handle.join().unwrap();
            }
        }
    }

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
    async fn uploaded_state_survives_final_checkpoint_failure_in_the_running_session() {
        let root = TempRoot::new();
        std::fs::write(root.0.join("new.md"), "new body").unwrap();
        let server = MutationServer::new();
        let mut connected = connected();
        connected.base_url = server.base_url.clone();
        connected.max_version = 1;
        connected.pull_cursor = 1;
        let state = Arc::new(Mutex::new(Some(connected)));
        let gate = Arc::new(Mutex::new(()));
        let no_progress = |_: crate::sync::SyncProgress| {};
        let no_pre_write = |_: &str| {};
        let saves = AtomicUsize::new(0);
        let fail_push_checkpoint = move |root: &Path, state: &ConnectedState| {
            if saves.fetch_add(1, Ordering::Relaxed) == 0 {
                Err("injected push checkpoint failure".into())
            } else {
                checkpoint::save(root, state)
            }
        };

        let summary = run_with_checkpoint(
            &state,
            &gate,
            &root.0,
            &no_progress,
            &no_pre_write,
            &fail_push_checkpoint,
        )
        .await
        .expect("checkpoint failure should be summarized");

        assert_eq!(summary.uploaded, 1);
        assert_eq!(
            summary
                .failures
                .iter()
                .filter(|failure| failure.kind == crate::sync::FailureKind::Checkpoint)
                .count(),
            1
        );
        assert!(state
            .lock()
            .await
            .as_ref()
            .unwrap()
            .object_map
            .contains_key("new.md"));

        run_with_checkpoint(
            &state,
            &gate,
            &root.0,
            &no_progress,
            &no_pre_write,
            &fail_push_checkpoint,
        )
        .await
        .expect("retry should keep running");
        assert_eq!(server.posts.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn downloaded_state_survives_final_checkpoint_failure_in_the_running_session() {
        let root = TempRoot::new();
        std::fs::write(root.0.join("seed.md"), "seed body").unwrap();
        let seed_metadata = std::fs::metadata(root.0.join("seed.md")).unwrap();
        let mut connected = connected();
        let server =
            MutationServer::with_remote_note(&connected.vault_key, "remote.md", "peer body");
        connected.base_url = server.base_url.clone();
        connected.max_version = 1;
        connected.pull_cursor = 1;
        connected.object_map.insert(
            "seed.md".into(),
            crate::checkpoint::ObjectState {
                object_id: "seed-object".into(),
                version: 1,
                blob_key: "seed-blob".into(),
                hash: Some(futo_notes_core::hash::hash_sha256("seed body")),
                mtime_ms: Some(futo_notes_core::files::file_mtime_ms(&seed_metadata)),
                size_bytes: Some(seed_metadata.len()),
            },
        );
        let state = Arc::new(Mutex::new(Some(connected)));
        let gate = Arc::new(Mutex::new(()));
        let no_progress = |_: crate::sync::SyncProgress| {};
        let no_pre_write = |_: &str| {};
        let saves = AtomicUsize::new(0);
        let fail_pull_checkpoint = move |root: &Path, state: &ConnectedState| {
            if saves.fetch_add(1, Ordering::Relaxed) == 1 {
                Err("injected pull checkpoint failure".into())
            } else {
                checkpoint::save(root, state)
            }
        };

        let summary = run_with_checkpoint(
            &state,
            &gate,
            &root.0,
            &no_progress,
            &no_pre_write,
            &fail_pull_checkpoint,
        )
        .await
        .unwrap();

        assert_eq!(summary.downloaded, 1);
        assert_eq!(
            summary
                .failures
                .iter()
                .filter(|failure| failure.kind == crate::sync::FailureKind::Checkpoint)
                .count(),
            1
        );
        assert!(state
            .lock()
            .await
            .as_ref()
            .unwrap()
            .object_map
            .contains_key("remote.md"));

        run_with_checkpoint(
            &state,
            &gate,
            &root.0,
            &no_progress,
            &no_pre_write,
            &fail_pull_checkpoint,
        )
        .await
        .unwrap();
        assert_eq!(server.posts.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn uploaded_state_survives_when_checkpoint_and_following_pull_fail() {
        let root = TempRoot::new();
        std::fs::write(root.0.join("new.md"), "new body").unwrap();
        let server = MutationServer::with_pull_failure();
        let mut connected = connected();
        connected.base_url = server.base_url.clone();
        connected.max_version = 1;
        connected.pull_cursor = 1;
        let state = Arc::new(Mutex::new(Some(connected)));
        let gate = Arc::new(Mutex::new(()));
        let no_progress = |_: crate::sync::SyncProgress| {};
        let no_pre_write = |_: &str| {};
        let fail_checkpoint =
            |_: &Path, _: &ConnectedState| Err("injected checkpoint failure".into());

        run_with_checkpoint(
            &state,
            &gate,
            &root.0,
            &no_progress,
            &no_pre_write,
            &fail_checkpoint,
        )
        .await
        .expect_err("the injected pull failure should abort the cycle");

        assert!(
            state
                .lock()
                .await
                .as_ref()
                .unwrap()
                .object_map
                .contains_key("new.md"),
            "the running session must retain the successful POST"
        );

        run_with_checkpoint(
            &state,
            &gate,
            &root.0,
            &no_progress,
            &no_pre_write,
            &fail_checkpoint,
        )
        .await
        .expect_err("the pull remains intentionally unavailable");
        assert_eq!(
            server.posts.load(Ordering::Relaxed),
            1,
            "retrying the failed pull must not POST the same note again"
        );
    }
}
