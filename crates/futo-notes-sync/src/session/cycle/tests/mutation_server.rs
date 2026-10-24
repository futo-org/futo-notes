//! A one-thread HTTP server that records mutations and can fail on cue.

use super::*;

pub(super) struct TempRoot(pub(super) PathBuf);

impl TempRoot {
    pub(super) fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-sync-session-checkpoint-test-{}-{}-{n}",
            std::process::id(),
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

pub(super) struct MutationServer {
    pub(super) base_url: String,
    pub(super) posts: Arc<AtomicUsize>,
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
    fail_delete_conflict: bool,
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
    } else if request_line.starts_with("GET /api/collections/collection/objects?sinceVersion=") {
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
    } else if fail_delete_conflict && request_line.starts_with("DELETE ") {
        (
            "409 Conflict",
            "application/json",
            br#"{"currentVersion":2,"currentBlobKey":"changed-blob"}"#.to_vec(),
        )
    } else if fail_delete_conflict
        && request_line.starts_with("GET /api/collections/collection/objects/deleted-object ")
    {
        (
            "500 Internal Server Error",
            "application/json",
            br#"{"error":"injected delete-conflict fetch failure"}"#.to_vec(),
        )
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
    pub(super) fn new() -> Self {
        Self::with_remote(None, false, false)
    }

    pub(super) fn with_pull_failure() -> Self {
        Self::with_remote(None, true, false)
    }

    pub(super) fn with_delete_conflict_failure() -> Self {
        Self::with_remote(None, false, true)
    }

    pub(super) fn with_remote_note(vault_key: &[u8; 32], name: &str, content: &str) -> Self {
        let plaintext = futo_notes_core::e2ee::pack_note_v2(name, content);
        let ciphertext = futo_notes_core::e2ee::aes_gcm_encrypt(vault_key, &plaintext).unwrap();
        Self::with_remote(Some(ciphertext), false, false)
    }

    fn with_remote(
        remote_blob: Option<Vec<u8>>,
        fail_pull: bool,
        fail_delete_conflict: bool,
    ) -> Self {
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
                        fail_delete_conflict,
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

pub(super) fn connected() -> ConnectedState {
    ConnectedState {
        base_url: "http://127.0.0.1:1".into(),
        token: "token".into(),
        user_id: "user".into(),
        collection_id: "collection".into(),
        vault_key: [3; 32],
        object_map: HashMap::new(),
        pending_creates: HashMap::new(),
        max_version: 0,
        pull_cursor: 0,
        oversize_skip: HashMap::new(),
    }
}
