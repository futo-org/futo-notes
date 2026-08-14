use std::time::Duration;

use futo_notes_core::e2ee::KeyMaterial;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};

mod batch_download;
mod batch_upload;
#[cfg(test)]
mod tests;

use batch_download::parse_batch_frames;
pub(crate) use batch_download::{BatchBlobEntry, BatchBlobStatus};
pub(crate) use batch_upload::{
    batch_write_frame_size, BatchMutation, BatchWriteEntry, BatchWriteOperation,
};
use batch_upload::{encode_batch_write_frames, parse_batch_write_results};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TRANSFER_FLOOR_BYTES_PER_SEC: u64 = 128 * 1024;
const MAX_TRANSFER_BYTES: u64 = 100 * 1024 * 1024;

fn transfer_timeout(payload_bytes: u64) -> Duration {
    REQUEST_TIMEOUT + Duration::from_secs(payload_bytes / TRANSFER_FLOOR_BYTES_PER_SEC)
}

// Downloads scale by a server-reported size, which is untrusted; cap it so a
// corrupt or hostile size cannot stretch the deadline. Uploads scale by the
// real payload length and stay uncapped.
fn download_timeout(expected_bytes: u64) -> Duration {
    transfer_timeout(expected_bytes.min(MAX_TRANSFER_BYTES))
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub(crate) struct HttpError {
    pub status: Option<u16>,
    pub message: String,
}

impl HttpError {
    pub fn is(&self, status: u16) -> bool {
        self.status == Some(status)
    }
}

/// Every failure that never reached a status line — DNS, no route, a refused or
/// reset connection, a stale pooled socket, TLS, a timeout, a truncated body.
///
/// `reqwest::Error`'s own `Display` names only the outermost layer ("error
/// sending request for url (…)") and drops `source()`, which is where the cause
/// actually lives. A desktop instance journal held 240 failed cycles across
/// three days carrying exactly that one line, and it could not be told apart
/// from a dead server, a poisoned connection pool, or a Tailscale route that
/// went away — so the whole chain is kept.
fn transport_error(error: reqwest::Error) -> HttpError {
    HttpError {
        status: error.status().map(|status| status.as_u16()),
        message: error_chain(&error),
    }
}

/// `outermost: next: …: root cause`, skipping a link that only repeats the text
/// its parent already printed (hyper and h2 wrap each other verbatim).
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !message.contains(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
}

#[derive(Clone)]
pub(crate) struct Http {
    base: String,
    token: Option<String>,
    request_client: reqwest::Client,
    event_client: reqwest::Client,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<String>,
}

fn number<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Value {
        Number(u64),
        String(String),
    }
    match Value::deserialize(deserializer)? {
        Value::Number(n) => Ok(n),
        Value::String(s) => s.parse().map_err(serde::de::Error::custom),
    }
}

// Advisory only (timeout scaling); an unparseable value must degrade to None
// rather than abort deserialization of a whole objects list.
fn optional_number<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(
        Option::<serde_json::Value>::deserialize(deserializer)?.and_then(|value| match value {
            serde_json::Value::Number(number) => number.as_u64(),
            serde_json::Value::String(string) => string.parse().ok(),
            _ => None,
        }),
    )
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Object {
    pub id: String,
    #[serde(deserialize_with = "number")]
    pub version: u64,
    #[serde(deserialize_with = "number")]
    pub change_seq: u64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub blob_key: Option<String>,
    #[serde(default, deserialize_with = "optional_number")]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Collection {
    pub id: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct Write {
    pub object: Object,
    pub collection_version: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct CreateWrite {
    pub write: Write,
    pub replayed: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conflict {
    #[serde(deserialize_with = "number")]
    pub current_version: u64,
    #[serde(default)]
    pub current_blob_key: Option<String>,
}

pub(crate) enum Mutation {
    Written(Write),
    Conflict(Conflict),
}

#[derive(Deserialize)]
struct WriteBody {
    object: Object,
    #[serde(rename = "collectionVersion", deserialize_with = "number")]
    collection_version: u64,
    replayed: Option<bool>,
}

impl From<WriteBody> for Write {
    fn from(body: WriteBody) -> Self {
        Self {
            object: body.object,
            collection_version: body.collection_version,
        }
    }
}

impl Http {
    pub fn new(base: &str) -> Result<Self, HttpError> {
        let base = base.trim().trim_end_matches('/');
        let url = url::Url::parse(base).map_err(|e| HttpError {
            status: None,
            message: format!("invalid server URL: {e}"),
        })?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(HttpError {
                status: None,
                message: "server URL must use http or https".into(),
            });
        }
        let request_client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(transport_error)?;
        let event_client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(transport_error)?;
        Ok(Self {
            base: base.to_owned(),
            token: None,
            request_client,
            event_client,
        })
    }

    pub fn token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.authorize(
            self.request_client
                .request(method, format!("{}{}", self.base, path)),
        )
    }

    fn authorize(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }

    async fn response_error(response: reqwest::Response) -> HttpError {
        let status = response.status().as_u16();
        let text = tokio::time::timeout(REQUEST_TIMEOUT, response.text())
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        let message = serde_json::from_str::<ErrorBody>(&text)
            .ok()
            .and_then(|body| body.error)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("HTTP {status}"));
        HttpError {
            status: Some(status),
            message,
        }
    }

    async fn json<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T, HttpError> {
        let response = request.send().await.map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        response.json().await.map_err(transport_error)
    }

    pub async fn auth_mode(&self) -> Result<String, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            auth_mode: String,
        }
        Ok(
            Self::json::<Body>(self.request(Method::GET, "/").timeout(PROBE_TIMEOUT))
                .await?
                .auth_mode,
        )
    }

    pub async fn login(&self, mode: &str, password: &str) -> Result<(String, String), HttpError> {
        #[derive(Deserialize)]
        struct User {
            id: String,
        }
        #[derive(Deserialize)]
        struct Body {
            user: User,
            token: String,
        }
        let request = if mode == "dev" {
            self.request(Method::POST, "/api/auth/dev/login")
                .json(&serde_json::json!({"email":"local@futo-notes.local","name":"FUTO Notes"}))
        } else {
            self.request(Method::POST, "/api/auth/password/login")
                .json(&serde_json::json!({"password":password}))
        };
        let body = Self::json::<Body>(request).await?;
        Ok((body.user.id, body.token))
    }

    pub async fn collections(&self) -> Result<Vec<Collection>, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            collections: Vec<Collection>,
        }
        Ok(
            Self::json::<Body>(self.request(Method::GET, "/api/collections"))
                .await?
                .collections,
        )
    }

    pub async fn create_collection(&self) -> Result<String, HttpError> {
        #[derive(Deserialize)]
        struct Collection {
            id: String,
        }
        #[derive(Deserialize)]
        struct Body {
            collection: Collection,
        }
        Ok(
            Self::json::<Body>(self.request(Method::POST, "/api/collections"))
                .await?
                .collection
                .id,
        )
    }

    pub async fn key(&self, collection: &str) -> Result<Option<KeyMaterial>, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            key: Option<KeyMaterial>,
        }
        Ok(Self::json::<Body>(
            self.request(Method::GET, &format!("/api/collections/{collection}/key")),
        )
        .await?
        .key)
    }

    pub async fn put_key(
        &self,
        collection: &str,
        key: &KeyMaterial,
    ) -> Result<KeyMaterial, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            key: KeyMaterial,
        }
        Ok(Self::json::<Body>(
            self.request(Method::PUT, &format!("/api/collections/{collection}/key"))
                .json(key),
        )
        .await?
        .key)
    }

    pub async fn objects(&self, collection: &str, since: u64) -> Result<Vec<Object>, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            objects: Vec<Object>,
        }
        Ok(Self::json::<Body>(self.request(
            Method::GET,
            &format!("/api/collections/{collection}/objects?sinceVersion={since}"),
        ))
        .await?
        .objects)
    }

    pub async fn object(&self, collection: &str, object: &str) -> Result<Object, HttpError> {
        #[derive(Deserialize)]
        struct Body {
            object: Object,
        }
        Ok(Self::json::<Body>(self.request(
            Method::GET,
            &format!("/api/collections/{collection}/objects/{object}"),
        ))
        .await?
        .object)
    }

    pub async fn blob(&self, key: &str, expected_bytes: u64) -> Result<Vec<u8>, HttpError> {
        let response = self
            .request(Method::GET, &format!("/api/blobs/{key}"))
            .timeout(download_timeout(expected_bytes))
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        response
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(transport_error)
    }

    pub async fn blobs_batch(
        &self,
        keys: &[String],
        expected_bytes: u64,
    ) -> Result<Vec<BatchBlobEntry>, HttpError> {
        let response = self
            .request(Method::POST, "/api/blobs/batch")
            .timeout(download_timeout(expected_bytes))
            .json(&serde_json::json!({ "keys": keys }))
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        let body = response.bytes().await.map_err(transport_error)?;
        let entries = parse_batch_frames(&body).map_err(|message| HttpError {
            status: None,
            message: format!("batch frames: {message}"),
        })?;
        if entries.len() != keys.len() {
            return Err(HttpError {
                status: None,
                message: format!(
                    "batch frames: expected {} entries, got {}",
                    keys.len(),
                    entries.len()
                ),
            });
        }
        Ok(entries)
    }

    async fn mutation(request: reqwest::RequestBuilder) -> Result<Mutation, HttpError> {
        let response = request.send().await.map_err(transport_error)?;
        if response.status() == StatusCode::CONFLICT {
            return response
                .json::<Conflict>()
                .await
                .map(Mutation::Conflict)
                // Keeps the 409 the caller dispatches on — only the body was
                // unreadable — but still names why it was unreadable.
                .map_err(|e| HttpError {
                    status: Some(409),
                    message: error_chain(&e),
                });
        }
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        response
            .json::<WriteBody>()
            .await
            .map(|body| Mutation::Written(body.into()))
            .map_err(transport_error)
    }

    pub async fn create_object(
        &self,
        collection: &str,
        mutation_id: &str,
        ciphertext: Vec<u8>,
    ) -> Result<CreateWrite, HttpError> {
        let timeout = transfer_timeout(ciphertext.len() as u64);
        let response = self
            .request(
                Method::POST,
                &format!("/api/collections/{collection}/blob-objects"),
            )
            .header("content-type", "application/octet-stream")
            .header("mutation-id", mutation_id)
            .timeout(timeout)
            .body(ciphertext)
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        let body = response
            .json::<WriteBody>()
            .await
            .map_err(transport_error)?;
        let replayed = body.replayed;
        Ok(CreateWrite {
            write: body.into(),
            replayed,
        })
    }

    pub async fn create_mutation(
        &self,
        collection: &str,
        mutation_id: &str,
    ) -> Result<CreateWrite, HttpError> {
        let body = Self::json::<WriteBody>(self.request(
            Method::GET,
            &format!("/api/collections/{collection}/create-mutations/{mutation_id}"),
        ))
        .await?;
        let replayed = body.replayed;
        Ok(CreateWrite {
            write: body.into(),
            replayed,
        })
    }

    pub async fn update_object(
        &self,
        collection: &str,
        object: &str,
        version: u64,
        ciphertext: Vec<u8>,
    ) -> Result<Mutation, HttpError> {
        let timeout = transfer_timeout(ciphertext.len() as u64);
        Self::mutation(
            self.request(
                Method::PUT,
                &format!("/api/collections/{collection}/blob-objects/{object}?version={version}"),
            )
            .header("content-type", "application/octet-stream")
            .timeout(timeout)
            .body(ciphertext),
        )
        .await
    }

    pub async fn write_objects_batch(
        &self,
        collection: &str,
        entries: &[BatchWriteEntry],
    ) -> Result<Vec<BatchMutation>, HttpError> {
        let body = encode_batch_write_frames(entries)?;
        let response = self
            .request(
                Method::POST,
                &format!("/api/collections/{collection}/blob-objects/batch"),
            )
            .header("content-type", "application/octet-stream")
            .timeout(transfer_timeout(body.len() as u64))
            .body(body)
            .send()
            .await
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        let body = response.bytes().await.map_err(transport_error)?;
        parse_batch_write_results(&body, entries)
    }

    pub async fn delete_object(
        &self,
        collection: &str,
        object: &str,
        version: u64,
    ) -> Result<Mutation, HttpError> {
        Self::mutation(self.request(
            Method::DELETE,
            &format!("/api/collections/{collection}/objects/{object}?version={version}"),
        ))
        .await
    }

    pub async fn events(&self) -> Result<reqwest::Response, HttpError> {
        let request = self.authorize(
            self.event_client
                .get(format!("{}/api/sync/events", self.base))
                .header("accept", "text/event-stream"),
        );
        let response = tokio::time::timeout(REQUEST_TIMEOUT, request.send())
            .await
            .map_err(|_| HttpError {
                status: None,
                message: "event stream response timed out".into(),
            })?
            .map_err(transport_error)?;
        if !response.status().is_success() {
            return Err(Self::response_error(response).await);
        }
        Ok(response)
    }
}

pub(crate) fn timestamp_ms(value: &str) -> i64 {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map(|t| t.unix_timestamp_nanos() / 1_000_000)
        .unwrap_or(0) as i64
}

// Test-only stalled-HTTP fixture, shared with the sync flow tests that need a
// server which accepts a request and then never (or only on release) responds.
#[cfg(test)]
pub(crate) mod stalled_http {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    const EVENT_STREAM_HEADERS: &[u8] =
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
    const SUCCESS_HEADERS: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
Content-Length: 64\r\nConnection: close\r\n\r\n";
    const ERROR_HEADERS: &[u8] = b"HTTP/1.1 500 Internal Server Error\r\n\
Content-Type: application/json\r\nConnection: close\r\n\r\n";
    const READY_EVENT: &[u8] = b"event: ready\ndata:\n\n";
    const WAKE_REQUEST: &[u8] = b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";

    #[derive(Clone, Copy)]
    pub(crate) enum StallPoint {
        ResponseHeaders,
        SuccessfulResponseBody,
        EventStreamBody,
        ErrorBody,
    }

    impl StallPoint {
        fn headers(self) -> Option<&'static [u8]> {
            match self {
                Self::ResponseHeaders => None,
                Self::SuccessfulResponseBody => Some(SUCCESS_HEADERS),
                Self::EventStreamBody => Some(EVENT_STREAM_HEADERS),
                Self::ErrorBody => Some(ERROR_HEADERS),
            }
        }

        fn body_after_release(self) -> Option<&'static [u8]> {
            match self {
                Self::EventStreamBody => Some(READY_EVENT),
                Self::ResponseHeaders | Self::SuccessfulResponseBody | Self::ErrorBody => None,
            }
        }
    }

    pub(crate) struct HangingServer {
        pub(crate) base_url: String,
        wake_address: SocketAddr,
        request_received: Receiver<()>,
        release: Option<Sender<()>>,
        handle: Option<JoinHandle<()>>,
    }

    impl HangingServer {
        pub(crate) fn new(stall_point: StallPoint) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let wake_address = listener.local_addr().unwrap();
            let base_url = format!("http://{wake_address}");
            let (request_received_tx, request_received) = mpsc::channel();
            let (release, release_rx) = mpsc::channel();
            let handle = std::thread::spawn(move || {
                serve_until_released(listener, stall_point, request_received_tx, release_rx)
            });
            Self {
                base_url,
                wake_address,
                request_received,
                release: Some(release),
                handle: Some(handle),
            }
        }

        pub(crate) async fn wait_for_request(&self) {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match self.request_received.try_recv() {
                    Ok(()) => return,
                    Err(TryRecvError::Empty) if Instant::now() < deadline => {
                        tokio::task::yield_now().await;
                        std::thread::yield_now();
                    }
                    Err(TryRecvError::Empty) => panic!("test server did not receive a request"),
                    Err(TryRecvError::Disconnected) => {
                        panic!("test server stopped before receiving a request")
                    }
                }
            }
        }

        pub(crate) fn release(&mut self) {
            self.release.take();
        }
    }

    fn serve_until_released(
        listener: TcpListener,
        stall_point: StallPoint,
        request_received: Sender<()>,
        release: Receiver<()>,
    ) {
        let (mut stream, _) = listener.accept().unwrap();
        read_request_headers(&mut stream);
        write_response_part(&mut stream, stall_point.headers()).unwrap();
        request_received.send(()).unwrap();

        let _ = release.recv();
        let _ = write_response_part(&mut stream, stall_point.body_after_release());
    }

    fn write_response_part(stream: &mut TcpStream, bytes: Option<&[u8]>) -> std::io::Result<()> {
        let Some(bytes) = bytes else {
            return Ok(());
        };
        stream.write_all(bytes)?;
        stream.flush()
    }

    fn wake_listener(address: SocketAddr) -> Option<TcpStream> {
        let mut stream = TcpStream::connect(address).ok()?;
        stream.write_all(WAKE_REQUEST).ok()?;
        stream.flush().ok()?;
        Some(stream)
    }

    impl Drop for HangingServer {
        fn drop(&mut self) {
            self.release();
            let _wake_connection = wake_listener(self.wake_address);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn read_request_headers(stream: &mut TcpStream) {
        let mut request = Vec::new();
        let mut chunk = [0; 1024];
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "request ended before its headers");
            request.extend_from_slice(&chunk[..read]);
        }
    }

    // Yields until the spawned request task observes its (paused-clock) timeout
    // firing and runs to completion; there is no event to await, only progress.
    pub(crate) async fn allow_timeout_task_to_finish<T>(task: &tokio::task::JoinHandle<T>) {
        for _ in 0..10 {
            if task.is_finished() {
                return;
            }
            tokio::task::yield_now().await;
        }
    }

    // Yields long enough for reqwest's connection task to send the request and
    // park in a pending read, so a later clock advance hits the armed timeout.
    pub(crate) async fn allow_network_task_to_settle() {
        for _ in 0..100 {
            tokio::task::yield_now().await;
        }
    }
}
