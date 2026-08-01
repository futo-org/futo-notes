//! Test-only fault injection for the sync flow.
//!
//! The rewrite deliberately removed the old mock HTTP client, so a failure that
//! only exists behind a particular server response can be reached only by
//! speaking the real protocol over a real socket. [`FaultServer`] is that
//! fixture: it serves a seeded remote vault and replaces selected responses
//! with an injected [`Fault`].
//!
//! Faults are targeted on three axes, which together reach the boundary cases
//! listed in `docs/learnings/sync-rewrite.md`:
//!
//! - **Phase** — a [`Route`] belongs to a phase. Push reaches `CreateObject`,
//!   `UpdateObject`, and `DeleteObject`; pull reaches `ListObjects`, `GetBlob`,
//!   and `GetObject`.
//! - **Request** — [`When::Nth`] fails one occurrence, so the retry on the next
//!   cycle meets a healthy server.
//! - **Process boundary** — a fault that aborts a cycle leaves behind exactly
//!   the checkpoint the client had persisted; [`restart_from_checkpoint`]
//!   rebuilds the session from it the way reconnecting does.
//!
//! Limitation: [`Fault::Status`] answers with an error body, so a 409 injected
//! on a mutation route arrives as a 409 transport error rather than the
//! structured optimistic-version conflict the real server sends. Conflict
//! resolution stays covered by the real-server suite.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::checkpoint::{self, ConnectedState};

const UPDATED_AT: &str = "2026-07-20T00:00:00Z";
const MAX_REQUEST_BYTES: usize = 1024 * 1024;

/// The endpoints of the server protocol that a sync cycle reaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Route {
    ListObjects,
    GetObject,
    GetBlob,
    CreateObject,
    UpdateObject,
    DeleteObject,
}

/// What a matching request receives instead of its normal response.
#[derive(Clone, Copy)]
pub(crate) enum Fault {
    /// Reply with this status and a JSON error body.
    Status(u16),
    /// Promise more bytes than are sent, then close the connection.
    TruncatedBody,
    /// Reply 200 with a body the client cannot parse.
    MalformedBody,
    /// Accept the request and never answer it. The connection stays open until
    /// the server is dropped, so only the client's own deadline ends the wait.
    Stall,
}

/// Which matching requests a fault applies to.
#[derive(Clone, Copy)]
pub(crate) enum When {
    Always,
    /// The nth matching request, counted from one.
    Nth(usize),
}

struct Rule {
    route: Route,
    /// Final path segment (blob key or object id) the rule is limited to.
    target: Option<String>,
    when: When,
    fault: Fault,
}

struct RemoteObject {
    id: String,
    change_seq: u64,
    deleted: bool,
    blob_key: String,
    blob: Vec<u8>,
}

/// A scripted server, configured before it starts listening.
pub(crate) struct FaultServer {
    objects: Vec<RemoteObject>,
    rules: Vec<Rule>,
}

impl FaultServer {
    pub(crate) fn new() -> Self {
        Self {
            objects: Vec::new(),
            rules: Vec::new(),
        }
    }

    /// Seed a live note the server lists and serves, encrypted for `vault_key`.
    pub(crate) fn note(
        mut self,
        vault_key: &[u8; 32],
        id: &str,
        change_seq: u64,
        name: &str,
        content: &str,
    ) -> Self {
        let plaintext = futo_notes_core::e2ee::pack_note_v2(name, content);
        let blob = futo_notes_core::e2ee::aes_gcm_encrypt(vault_key, &plaintext).unwrap();
        self.objects.push(RemoteObject {
            id: id.to_owned(),
            change_seq,
            deleted: false,
            blob_key: format!("{id}-blob"),
            blob,
        });
        self
    }

    /// Seed a peer deletion the server lists at `change_seq`.
    pub(crate) fn tombstone(mut self, id: &str, change_seq: u64) -> Self {
        self.objects.push(RemoteObject {
            id: id.to_owned(),
            change_seq,
            deleted: true,
            blob_key: String::new(),
            blob: Vec::new(),
        });
        self
    }

    pub(crate) fn fail(mut self, route: Route, when: When, fault: Fault) -> Self {
        self.rules.push(Rule {
            route,
            target: None,
            when,
            fault,
        });
        self
    }

    /// Fail only the blob belonging to `object_id`, leaving its peers healthy.
    pub(crate) fn fail_blob_of(mut self, object_id: &str, when: When, fault: Fault) -> Self {
        self.rules.push(Rule {
            route: Route::GetBlob,
            target: Some(format!("{object_id}-blob")),
            when,
            fault,
        });
        self
    }

    pub(crate) fn start(self) -> RunningFaultServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let counts = Arc::new(Mutex::new(HashMap::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let mut handler = Handler {
            objects: self.objects,
            matched: vec![0; self.rules.len()],
            rules: self.rules,
            next_change_seq: 1_000,
            counts: Arc::clone(&counts),
        };
        let should_stop = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            // Stalled connections stay open so the client waits on its own
            // deadline; they are closed when this thread exits.
            let mut stalled = Vec::new();
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if should_stop.load(Ordering::Relaxed) {
                            break;
                        }
                        if let Ok(Disposition::Stalled) = handler.serve(&mut stream) {
                            stalled.push(stream);
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => panic!("fault server failed: {error}"),
                }
            }
        });
        RunningFaultServer {
            base_url: format!("http://{address}"),
            address,
            counts,
            stop,
            handle: Some(handle),
        }
    }
}

pub(crate) struct RunningFaultServer {
    pub(crate) base_url: String,
    address: SocketAddr,
    counts: Arc<Mutex<HashMap<Route, usize>>>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl RunningFaultServer {
    /// How many requests reached `route`, faulted or not.
    pub(crate) fn requests(&self, route: Route) -> usize {
        self.counts
            .lock()
            .unwrap()
            .get(&route)
            .copied()
            .unwrap_or(0)
    }

    /// Yield until `route` has been reached `count` times. Awaiting keeps the
    /// runtime busy, so a paused clock cannot auto-advance past the client's
    /// deadline while a real socket round trip is still in flight.
    pub(crate) async fn wait_for_requests(&self, route: Route, count: usize) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while self.requests(route) < count {
            assert!(
                std::time::Instant::now() < deadline,
                "the fault server never received {count} {route:?} request(s)"
            );
            tokio::task::yield_now().await;
            std::thread::yield_now();
        }
    }
}

impl Drop for RunningFaultServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Wake the blocking accept so the thread can observe the stop flag.
        let _ = TcpStream::connect(self.address);
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
    }
}

/// Rebuild a session from the checkpoint an interrupted cycle left on disk, the
/// way `session::connect` does after a process restart.
pub(crate) fn restart_from_checkpoint(root: &Path, previous: &ConnectedState) -> ConnectedState {
    let loaded = checkpoint::load(root, &previous.collection_id);
    ConnectedState {
        object_map: loaded.object_map,
        max_version: loaded.max_version,
        pull_cursor: loaded.pull_cursor,
        oversize_skip: HashMap::new(),
        ..previous.clone()
    }
}

enum Disposition {
    Answered,
    Stalled,
}

struct Request {
    route: Route,
    target: String,
    query: String,
}

struct Handler {
    objects: Vec<RemoteObject>,
    rules: Vec<Rule>,
    matched: Vec<usize>,
    next_change_seq: u64,
    counts: Arc<Mutex<HashMap<Route, usize>>>,
}

impl Handler {
    fn serve(&mut self, stream: &mut TcpStream) -> std::io::Result<Disposition> {
        let headers = read_request(stream)?;
        let Some(request) = classify(headers.lines().next().unwrap_or_default()) else {
            write_response(
                stream,
                "501 Not Implemented",
                "application/json",
                br#"{"error":"the fault server does not implement this request"}"#,
            )?;
            return Ok(Disposition::Answered);
        };
        *self
            .counts
            .lock()
            .unwrap()
            .entry(request.route)
            .or_default() += 1;

        match self.fault_for(&request) {
            Some(Fault::Stall) => return Ok(Disposition::Stalled),
            Some(Fault::Status(code)) => {
                let body = format!(r#"{{"error":"injected HTTP {code}"}}"#);
                write_response(
                    stream,
                    &format!("{code} Injected"),
                    "application/json",
                    body.as_bytes(),
                )?;
            }
            Some(Fault::TruncatedBody) => write_truncated(stream)?,
            Some(Fault::MalformedBody) => write_response(
                stream,
                "200 OK",
                "application/json",
                br#"{"objects":"not a list"}"#,
            )?,
            None => {
                let (status, content_type, body) = self.respond(&request);
                write_response(stream, status, content_type, &body)?;
            }
        }
        Ok(Disposition::Answered)
    }

    fn fault_for(&mut self, request: &Request) -> Option<Fault> {
        for (index, rule) in self.rules.iter().enumerate() {
            if rule.route != request.route {
                continue;
            }
            if rule
                .target
                .as_ref()
                .is_some_and(|target| target != &request.target)
            {
                continue;
            }
            self.matched[index] += 1;
            let applies = match rule.when {
                When::Always => true,
                When::Nth(occurrence) => self.matched[index] == occurrence,
            };
            if applies {
                return Some(rule.fault);
            }
        }
        None
    }

    fn respond(&mut self, request: &Request) -> (&'static str, &'static str, Vec<u8>) {
        match request.route {
            Route::ListObjects => {
                let since = query_value(&request.query, "sinceVersion").unwrap_or(0);
                let objects: Vec<_> = self
                    .objects
                    .iter()
                    .filter(|object| object.change_seq > since)
                    .map(object_json)
                    .collect();
                json(serde_json::json!({ "objects": objects }))
            }
            Route::GetObject => match self
                .objects
                .iter()
                .find(|object| object.id == request.target)
            {
                Some(object) => json(serde_json::json!({ "object": object_json(object) })),
                None => not_found("unknown object"),
            },
            Route::GetBlob => match self
                .objects
                .iter()
                .find(|object| object.blob_key == request.target)
            {
                Some(object) => ("200 OK", "application/octet-stream", object.blob.clone()),
                None => not_found("unknown blob"),
            },
            Route::CreateObject => {
                let seq = self.allocate_change_seq();
                json(write_json(&format!("created-{seq}"), 1, seq, false))
            }
            Route::UpdateObject => {
                let seq = self.allocate_change_seq();
                json(write_json(&request.target, 2, seq, false))
            }
            Route::DeleteObject => {
                let seq = self.allocate_change_seq();
                json(write_json(&request.target, 2, seq, true))
            }
        }
    }

    fn allocate_change_seq(&mut self) -> u64 {
        self.next_change_seq += 1;
        self.next_change_seq
    }
}

fn object_json(object: &RemoteObject) -> serde_json::Value {
    serde_json::json!({
        "id": object.id,
        "version": 1,
        "change_seq": object.change_seq,
        "deleted": object.deleted,
        "blob_key": (!object.deleted).then(|| object.blob_key.clone()),
        "updated_at": UPDATED_AT,
    })
}

fn write_json(id: &str, version: u64, change_seq: u64, deleted: bool) -> serde_json::Value {
    serde_json::json!({
        "object": {
            "id": id,
            "version": version,
            "change_seq": change_seq,
            "deleted": deleted,
            "blob_key": (!deleted).then(|| format!("{id}-blob")),
            "updated_at": UPDATED_AT,
        },
        "collectionVersion": change_seq,
    })
}

fn json(value: serde_json::Value) -> (&'static str, &'static str, Vec<u8>) {
    ("200 OK", "application/json", value.to_string().into_bytes())
}

fn not_found(message: &str) -> (&'static str, &'static str, Vec<u8>) {
    (
        "404 Not Found",
        "application/json",
        serde_json::json!({ "error": message })
            .to_string()
            .into_bytes(),
    )
}

fn classify(request_line: &str) -> Option<Request> {
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    let full_path = parts.next()?;
    let (path, query) = full_path.split_once('?').unwrap_or((full_path, ""));
    let route = match method {
        "GET" if path.starts_with("/api/blobs/") => Route::GetBlob,
        "GET" if path.ends_with("/objects") => Route::ListObjects,
        "GET" if path.contains("/objects/") => Route::GetObject,
        "POST" if path.ends_with("/blob-objects") => Route::CreateObject,
        "PUT" if path.contains("/blob-objects/") => Route::UpdateObject,
        "DELETE" if path.contains("/objects/") => Route::DeleteObject,
        _ => return None,
    };
    Some(Request {
        route,
        target: path.rsplit('/').next().unwrap_or_default().to_owned(),
        query: query.to_owned(),
    })
}

fn query_value(query: &str, name: &str) -> Option<u64> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .and_then(|(_, value)| value.parse().ok())
}

fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()
}

fn write_truncated(stream: &mut TcpStream) -> std::io::Result<()> {
    const BODY: &[u8] = b"truncated";
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        BODY.len() + 64
    )?;
    stream.write_all(BODY)?;
    stream.flush()
}

// The whole request must be consumed before answering: a client that is still
// writing its body sees a connection reset instead of the injected response.
fn read_request(stream: &mut TcpStream) -> std::io::Result<String> {
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
                "request exceeds fault server limit",
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
                "request exceeds fault server limit",
            ));
        }
    }

    Ok(String::from_utf8_lossy(&request[..header_end]).into_owned())
}
