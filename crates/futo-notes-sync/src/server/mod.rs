use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futo_notes_core::e2ee::KeyMaterial;
use reqwest::{Method, StatusCode};
use rustls::client::danger::ServerCertVerifier;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};

mod account;
mod batch_download;
mod batch_upload;
mod hosted;
mod objects;
#[cfg(test)]
mod tests;

use batch_download::parse_batch_frames;
pub(crate) use batch_download::{BatchBlobEntry, BatchBlobStatus};
pub(crate) use batch_upload::{
    batch_write_frame_size, BatchMutation, BatchWriteEntry, BatchWriteOperation,
};
use batch_upload::{encode_batch_write_frames, parse_batch_write_results};
pub(crate) use hosted::{hosted_error, HandoffPoll, PairingPoll};

use crate::tls::RememberingVerifier;

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

#[derive(Clone, Debug, thiserror::Error)]
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

/// How a re-wrap of the vault's key material ended.
///
/// Losing the guard is not a failure to report as one: the server hands back
/// the material that is actually stored, and re-wrapping from that is the
/// whole of the fix.
pub(crate) enum KeyRewrap {
    Written(KeyMaterial),
    /// The revision token was stale — another device re-wrapped in between.
    /// This is the authoritative material, as the server sent it.
    Stale(KeyMaterial),
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
    pool_generation: u64,
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

/// The two connection pools owned by one sync session. Cloned `Http` values
/// keep these pools warm across connect, push, pull, and SSE reconnects without
/// sharing sockets with another session.
///
/// The TLS trust store is resolved once here, before any base URL is known —
/// `HttpClients::new()` is reached from `SyncSession::default()`, ahead of
/// `connect`/`resume`. A store that fails to build (an unparsable extra root,
/// a broken crypto provider) is not fatal here: only an `https://` base
/// actually needs it, and that check happens in [`Http::with_clients`], the one
/// place a base URL and this store meet. An `http://` base still works with
/// pooled, unencrypted connections.
#[derive(Clone)]
pub(crate) struct HttpClients {
    trust: Result<Arc<dyn ServerCertVerifier>, HttpError>,
    connections: Arc<Mutex<Connections>>,
}

struct Connections {
    verifier: Option<Arc<RememberingVerifier>>,
    request: reqwest::Client,
    event: reqwest::Client,
    generation: u64,
}

impl Connections {
    fn open(
        trust: Option<&Arc<dyn ServerCertVerifier>>,
        generation: u64,
    ) -> Result<Self, HttpError> {
        let verifier = trust.map(|trust| Arc::new(RememberingVerifier::new(trust.clone())));
        let tls = verifier
            .clone()
            .map(|verifier| crate::tls::client_config_with(verifier))
            .transpose()
            .map_err(|error| HttpError {
                status: None,
                message: crate::tls::trust_store_error(error),
            })?;
        let builder = || {
            let builder = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT);
            match &tls {
                Some(tls) => builder.use_preconfigured_tls((**tls).clone()),
                None => builder,
            }
        };
        Ok(Self {
            verifier,
            request: builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .map_err(transport_error)?,
            event: builder().build().map_err(transport_error)?,
            generation,
        })
    }

    fn still_trusted(&self) -> bool {
        self.verifier
            .as_ref()
            .is_none_or(|verifier| verifier.trusts_every_verified_chain())
    }
}

impl HttpClients {
    pub(crate) fn new() -> Result<Self, HttpError> {
        Self::with_verifier(None)
    }

    pub(crate) fn with_verifier(
        verifier: Option<Arc<dyn ServerCertVerifier>>,
    ) -> Result<Self, HttpError> {
        let trust = verifier
            .map_or_else(crate::tls::shared_verifier, Ok)
            .map_err(|message| HttpError {
                status: None,
                message,
            });
        let connections = Connections::open(trust.as_ref().ok(), 0)?;
        Ok(Self {
            trust,
            connections: Arc::new(Mutex::new(connections)),
        })
    }

    pub(crate) fn for_base(&self, base: &str) -> Result<Http, HttpError> {
        let mut connections = self
            .connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !connections.still_trusted() {
            *connections = Connections::open(self.trust.as_ref().ok(), connections.generation + 1)?;
        }
        Http::with_clients(base, self, &connections)
    }

    pub(crate) fn generation(&self) -> u64 {
        self.connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .generation
    }
}

impl Http {
    #[cfg(test)]
    pub fn new(base: &str) -> Result<Self, HttpError> {
        HttpClients::new()?.for_base(base)
    }

    #[cfg(test)]
    pub(crate) fn with_verifier(
        base: &str,
        verifier: Arc<dyn ServerCertVerifier>,
    ) -> Result<Self, HttpError> {
        HttpClients::with_verifier(Some(verifier))?.for_base(base)
    }

    pub(crate) fn pool_generation(&self) -> u64 {
        self.pool_generation
    }

    fn with_clients(
        base: &str,
        clients: &HttpClients,
        connections: &Connections,
    ) -> Result<Self, HttpError> {
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
        // An http:// base tolerates a trust store that failed to build — it
        // never needs one. An https:// base cannot: refuse it here, before any
        // request, exactly as it would have if the store had failed while
        // building this base's own client.
        if url.scheme() == "https" {
            if let Err(error) = &clients.trust {
                return Err(error.clone());
            }
        }
        Ok(Self {
            base: base.to_owned(),
            token: None,
            request_client: connections.request.clone(),
            event_client: connections.event.clone(),
            pool_generation: connections.generation,
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
}

pub(crate) fn timestamp_ms(value: &str) -> i64 {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map(|t| t.unix_timestamp_nanos() / 1_000_000)
        .unwrap_or(0) as i64
}

// Test-only stalled-HTTP fixture, shared with the sync flow tests that need a
// server which accepts a request and then never (or only on release) responds.
#[cfg(test)]
pub(crate) mod stalled_http;
